/* eslint-disable @typescript-eslint/no-explicit-any -- untyped vendor JSON read defensively */
/**
 * Ads Pulse reads. READ-ONLY toward every platform: no writes.
 *
 * Every account comes from environment variables (see .env.example):
 *   GOOGLE_ADS_ACCOUNTS       "1234567890:Search,2345678901:Brand" (customer ids, digits or dashed, with a label)
 *   GOOGLE_ADS_LSA_ACCOUNTS   same format, for Local Services Ads accounts (leads read as conversions)
 *   GOOGLE_ADS_LOGIN_CUSTOMER_ID  your manager (MCC) id, sent for accounts listed in GOOGLE_ADS_MCC_CHILDREN
 *                                 (or for every non-LSA account when GOOGLE_ADS_MCC_CHILDREN is unset)
 *   APPLE_ADS_*               Apple Ads API (OAuth client credentials, ES256)
 *   OPENAI_ADS_API_KEY        ChatGPT Ads reporting (optional)
 *
 * Gotcha worth knowing: an account that is NOT under your manager account rejects a
 * login-customer-id header with an authorization error that looks like a revoked
 * credential. List only real MCC children in GOOGLE_ADS_MCC_CHILDREN if that bites.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import {
	type AccountPulse,
	type CampaignPulse,
	type Metric,
	type TrendPoint,
	addDays,
	dayElapsed,
	densify,
	flagsFor,
	localDate,
	metric,
	pace,
	round2,
	sumMetrics,
	totalBudget,
	unreadAccount,
	ZERO,
} from "./core";

const GADS_VERSION = process.env.GOOGLE_ADS_API_VERSION || "v24";
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const digits = (s: string) => s.replace(/\D/g, "");
const env = (k: string) => (process.env[k] ?? "").trim();

// ─────────────────────────── config ───────────────────────────

export interface GoogleSpec {
	id: string;
	name: string;
	cid: string;
	lsa: boolean;
	login: string | null;
}

/** "123-456-7890:Label,2345678901" → [{cid, label}] */
export function parseAccounts(v: string): { cid: string; label: string | null }[] {
	return v
		.split(",")
		.map((x) => x.trim())
		.filter(Boolean)
		.map((x) => {
			const i = x.indexOf(":");
			const cid = digits(i < 0 ? x : x.slice(0, i));
			const label = i < 0 ? null : x.slice(i + 1).trim() || null;
			return { cid, label };
		})
		.filter((a) => a.cid.length === 10);
}

export function googleSpecs(e: Record<string, string | undefined> = process.env): GoogleSpec[] {
	const mcc = digits(e.GOOGLE_ADS_LOGIN_CUSTOMER_ID ?? "") || null;
	const children = e.GOOGLE_ADS_MCC_CHILDREN ? new Set(parseAccounts(e.GOOGLE_ADS_MCC_CHILDREN).map((a) => a.cid)) : null;
	const dash = (c: string) => `${c.slice(0, 3)}-${c.slice(3, 6)}-${c.slice(6)}`;
	const out: GoogleSpec[] = [];
	for (const [list, lsa] of [[e.GOOGLE_ADS_ACCOUNTS ?? "", false], [e.GOOGLE_ADS_LSA_ACCOUNTS ?? "", true]] as const) {
		for (const a of parseAccounts(list)) {
			const underMcc = mcc && (children ? children.has(a.cid) : !lsa);
			out.push({ id: `google-${lsa ? "lsa-" : ""}${a.cid}`, name: a.label ?? `${lsa ? "LSA" : "Google Ads"} ${dash(a.cid)}`, cid: a.cid, lsa, login: underMcc ? mcc : null });
		}
	}
	return out;
}

// ─────────────────────────── Google Ads ───────────────────────────

async function googleToken(f: typeof fetch): Promise<string> {
	const r = await f("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: env("GOOGLE_ADS_CLIENT_ID"),
			client_secret: env("GOOGLE_ADS_CLIENT_SECRET"),
			refresh_token: env("GOOGLE_ADS_REFRESH_TOKEN"),
			grant_type: "refresh_token",
		}),
		signal: AbortSignal.timeout(20_000),
	});
	const j = (await r.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
	if (!j.access_token) throw new Error(`Google OAuth refresh failed (HTTP ${r.status}): ${j.error_description ?? j.error ?? "no token"}`);
	return j.access_token;
}

async function gaql(f: typeof fetch, token: string, spec: GoogleSpec, query: string): Promise<Record<string, any>[]> {
	const rows: Record<string, any>[] = [];
	let pageToken: string | undefined;
	do {
		const r = await f(`https://googleads.googleapis.com/${GADS_VERSION}/customers/${spec.cid}/googleAds:search`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				...(env("GOOGLE_ADS_DEVELOPER_TOKEN") ? { "developer-token": env("GOOGLE_ADS_DEVELOPER_TOKEN") } : {}),
				...(spec.login ? { "login-customer-id": spec.login } : {}),
			},
			body: JSON.stringify(pageToken ? { query, pageToken } : { query }),
			signal: AbortSignal.timeout(25_000),
		});
		if (!r.ok) throw new Error(`GAQL ${r.status}: ${(await r.text()).slice(0, 240)}`);
		const j = (await r.json()) as { results?: Record<string, any>[]; nextPageToken?: string };
		rows.push(...(j.results ?? []));
		pageToken = j.nextPageToken;
	} while (pageToken);
	return rows;
}

const micros = (v: unknown) => (v == null ? 0 : Number(v) / 1_000_000);
const n = (v: unknown) => (v == null ? 0 : Number(v) || 0);

/** Account-zone wall time "2026-08-03 12:26:00" → ISO instant (DST-aware). */
export function wallToIso(wall: string, timeZone: string): string | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(wall);
	if (!m) return null;
	const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
	const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(new Date(asUtc));
	const off = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
	const om = /GMT([+-])(\d{2}):?(\d{2})?/.exec(off);
	const offMin = om ? (om[1] === "-" ? -1 : 1) * (Number(om[2]) * 60 + Number(om[3] ?? 0)) : 0;
	return new Date(asUtc - offMin * 60_000).toISOString();
}

export async function readGoogle(spec: GoogleSpec, now: Date, token: string, f: typeof fetch = fetch): Promise<AccountPulse> {
	const base = { id: spec.id, platform: spec.lsa ? ("google_lsa" as const) : ("google_ads" as const), name: spec.name, accountRef: `${spec.cid.slice(0, 3)}-${spec.cid.slice(3, 6)}-${spec.cid.slice(6)}`, timeZone: "UTC", currency: "USD" };
	let cust: Record<string, any>[];
	try {
		cust = await gaql(f, token, spec, "SELECT customer.time_zone, customer.currency_code FROM customer LIMIT 1");
	} catch (e) {
		return unreadAccount(base, "error", errMsg(e), now);
	}
	const tz = cust[0]?.customer?.timeZone ?? "UTC";
	const currency = cust[0]?.customer?.currencyCode ?? "USD";
	const today = localDate(now, tz);
	const start7 = addDays(today, -6);
	const failures: string[] = [];
	const safe = <T>(label: string, p: Promise<T>, fb: T): Promise<T> => p.catch((e) => (failures.push(`${label}: ${errMsg(e)}`), fb));

	const [camps, perf, disRows, leadRows] = await Promise.all([
		// Metric-free, so campaigns with no activity still appear.
		safe("campaigns", gaql(f, token, spec, `SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status, campaign_budget.resource_name, campaign_budget.amount_micros FROM campaign WHERE campaign.status IN ('ENABLED', 'PAUSED')`), null as Record<string, any>[] | null),
		safe(
			"metrics",
			gaql(f, token, spec, `SELECT campaign.id, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date BETWEEN '${start7}' AND '${today}' AND campaign.status IN ('ENABLED', 'PAUSED')`),
			null as Record<string, any>[] | null,
		),
		spec.lsa
			? Promise.resolve([] as Record<string, any>[])
			: safe("disapprovals", gaql(f, token, spec, `SELECT campaign.id, ad_group_ad.policy_summary.approval_status FROM ad_group_ad WHERE campaign.status = 'ENABLED' AND ad_group.status = 'ENABLED' AND ad_group_ad.status = 'ENABLED'`), null as Record<string, any>[] | null),
		spec.lsa
			? safe("lsa leads", gaql(f, token, spec, `SELECT local_services_lead.creation_date_time FROM local_services_lead`), null as Record<string, any>[] | null)
			: safe("conversion dates", gaql(f, token, spec, `SELECT segments.date, metrics.conversions_by_conversion_date FROM customer WHERE segments.date BETWEEN '${addDays(today, -89)}' AND '${today}'`), null as Record<string, any>[] | null),
	]);
	const readAt = new Date().toISOString();

	const byCamp = new Map<string, { t: Metric[]; w: Metric[] }>();
	const daily: TrendPoint[] = [];
	for (const r of perf ?? []) {
		const id = String(r.campaign?.id ?? "");
		const m = metric(micros(r.metrics?.costMicros), n(r.metrics?.clicks), n(r.metrics?.impressions), n(r.metrics?.conversions));
		daily.push({ date: String(r.segments?.date), spend: m.spend, clicks: m.clicks, impressions: m.impressions, conversions: m.conversions });
		const e = byCamp.get(id) ?? { t: [], w: [] };
		e.w.push(m);
		if (r.segments?.date === today) e.t.push(m);
		byCamp.set(id, e);
	}
	const disBy = new Map<string, number>();
	for (const r of disRows ?? []) if (r.adGroupAd?.policySummary?.approvalStatus === "DISAPPROVED") disBy.set(String(r.campaign?.id), (disBy.get(String(r.campaign?.id)) ?? 0) + 1);

	const lsaDay = new Map<string, number>();
	let lastLeadAt: string | null = null;
	let lastLeadBasis: string | null = null;
	if (spec.lsa && leadRows) {
		lastLeadBasis = "LSA lead created";
		for (const r of leadRows) {
			const wall = String(r.localServicesLead?.creationDateTime ?? "");
			const iso = wallToIso(wall, tz);
			if (!iso) continue;
			lsaDay.set(wall.slice(0, 10), (lsaDay.get(wall.slice(0, 10)) ?? 0) + 1);
			if (!lastLeadAt || iso > lastLeadAt) lastLeadAt = iso;
		}
	} else if (leadRows) {
		lastLeadBasis = "last day with a conversion (by conversion date, 90-day window)";
		for (const r of leadRows) if (n(r.metrics?.conversionsByConversionDate) > 0 && (!lastLeadAt || r.segments.date > lastLeadAt)) lastLeadAt = String(r.segments.date);
	}

	const campaigns: CampaignPulse[] = (camps ?? []).map((r) => {
		const id = String(r.campaign?.id ?? "");
		const e = byCamp.get(id) ?? { t: [], w: [] };
		return {
			id,
			name: String(r.campaign?.name ?? "(unnamed)"),
			status: String(r.campaign?.status ?? "UNKNOWN"),
			servingStatus: r.campaign?.servingStatus ? String(r.campaign.servingStatus) : null,
			dailyBudget: r.campaignBudget?.amountMicros != null ? round2(micros(r.campaignBudget.amountMicros)) : null,
			today: e.t.length ? sumMetrics(e.t) : ZERO,
			last7: e.w.length ? sumMetrics(e.w) : ZERO,
			disapprovedAds: spec.lsa || disRows == null ? null : disBy.get(id) ?? 0,
		};
	});
	let todayM: Metric | null = perf ? sumMetrics(Array.from(byCamp.values()).flatMap((e) => e.t)) : null;
	let weekM: Metric | null = perf ? sumMetrics(Array.from(byCamp.values()).flatMap((e) => e.w)) : null;
	let trend = perf ? densify(today, daily) : [];
	if (spec.lsa && leadRows) {
		let leadsWeek = 0;
		for (const [d, c] of Array.from(lsaDay.entries())) if (d >= start7 && d <= today) leadsWeek += c;
		if (todayM) todayM = metric(todayM.spend, todayM.clicks, todayM.impressions, lsaDay.get(today) ?? 0);
		if (weekM) weekM = metric(weekM.spend, weekM.clicks, weekM.impressions, leadsWeek);
		trend = trend.map((p) => ({ ...p, conversions: lsaDay.get(p.date) ?? 0 }));
	}
	campaigns.sort((a, b) => b.last7.spend - a.last7.spend || a.name.localeCompare(b.name));
	const dailyBudget = camps
		? totalBudget(camps.map((r) => ({ status: String(r.campaign?.status), servingStatus: r.campaign?.servingStatus ?? null, budget: r.campaignBudget?.amountMicros != null ? micros(r.campaignBudget.amountMicros) : null, budgetKey: r.campaignBudget?.resourceName ?? null })))
		: null;
	const a: AccountPulse = {
		...base,
		timeZone: tz,
		currency,
		status: failures.length === 0 ? "ok" : perf ? "partial" : "error",
		error: failures.length ? failures.join(" | ") : null,
		todayDate: today,
		last7Start: start7,
		today: todayM,
		last7: weekM,
		trend,
		dailyBudget,
		pace: pace(todayM?.spend ?? null, dailyBudget, dayElapsed(now, tz)),
		lastLeadAt,
		lastLeadBasis,
		campaigns: campaigns.filter((c) => c.status === "ENABLED" || c.last7.spend > 0 || c.last7.impressions > 0),
		flags: [],
		readAt: { metrics: perf ? readAt : null, lastLead: leadRows ? readAt : null },
		note: spec.lsa ? "Conversions = LSA leads created that day (account time). No zero-impression flag for LSA." : null,
	};
	// Google may spend up to 2x a daily budget on one day.
	a.flags = flagsFor(a, { budgetSlack: 2, zeroImpressions: !spec.lsa });
	return a;
}

// ─────────────────────────── Apple Ads ───────────────────────────

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** ES256 client secret for Apple Ads OAuth, 1-hour life, signed fresh per read. */
export function appleClientSecret(pem: string, ids: { clientId: string; teamId: string; keyId: string }, nowSec = Math.floor(Date.now() / 1000)): string {
	const head = b64u(JSON.stringify({ alg: "ES256", kid: ids.keyId, typ: "JWT" }));
	const body = b64u(JSON.stringify({ sub: ids.clientId, iss: ids.teamId, aud: "https://appleid.apple.com", iat: nowSec, exp: nowSec + 3600 }));
	const sig = crypto.sign("sha256", Buffer.from(`${head}.${body}`), { key: crypto.createPrivateKey(pem), dsaEncoding: "ieee-p1363" });
	return `${head}.${body}.${b64u(sig)}`;
}

function applePem(): string | null {
	const v = env("APPLE_ADS_PRIVATE_KEY");
	if (v.includes("PRIVATE KEY")) return v.replace(/\\n/g, "\n");
	const p = env("APPLE_ADS_PRIVATE_KEY_PATH");
	if (p) {
		try {
			return fs.readFileSync(p.replace(/^~/, process.env.HOME ?? ""), "utf8");
		} catch {
			return null;
		}
	}
	return null;
}

const money = (v: any) => Number(v?.amount ?? 0) || 0;

export function appleConfigured(): boolean {
	return Boolean(env("APPLE_ADS_CLIENT_ID") && env("APPLE_ADS_ORG_ID"));
}

export async function readApple(now: Date, f: typeof fetch = fetch): Promise<AccountPulse> {
	const orgId = env("APPLE_ADS_ORG_ID");
	const ids = { clientId: env("APPLE_ADS_CLIENT_ID"), teamId: env("APPLE_ADS_TEAM_ID") || env("APPLE_ADS_CLIENT_ID"), keyId: env("APPLE_ADS_KEY_ID") };
	const base = { id: `apple-${orgId}`, platform: "apple_ads" as const, name: env("APPLE_ADS_LABEL") || "Apple Ads", accountRef: `org ${orgId}`, timeZone: "UTC", currency: "USD" };
	const pem = applePem();
	if (!pem || !ids.keyId) return unreadAccount(base, "not_configured", "APPLE_ADS_PRIVATE_KEY (or _PATH) and APPLE_ADS_KEY_ID are required", now);
	let token: string;
	try {
		const r = await f("https://appleid.apple.com/auth/oauth2/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ grant_type: "client_credentials", client_id: ids.clientId, client_secret: appleClientSecret(pem, ids), scope: "searchadsorg" }),
			signal: AbortSignal.timeout(20_000),
		});
		const j = (await r.json().catch(() => ({}))) as { access_token?: string; error?: string };
		if (!j.access_token) throw new Error(`Apple token HTTP ${r.status}: ${j.error ?? "no token"}`);
		token = j.access_token;
	} catch (e) {
		return unreadAccount(base, "error", errMsg(e), now);
	}
	const API = "https://api.searchads.apple.com/api/v5";
	const call = async (method: string, path: string, body?: unknown, org = true) => {
		const r = await f(API + path, {
			method,
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(org ? { "X-AP-Context": `orgId=${orgId}` } : {}) },
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(25_000),
		});
		if (!r.ok) throw new Error(`Apple ${path} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
		return (await r.json()) as any;
	};
	let tz = "UTC";
	let currency = "USD";
	try {
		const acls = await call("GET", "/acls", undefined, false);
		const me = (acls.data ?? []).find((o: any) => String(o.orgId) === orgId);
		if (me?.timeZone) tz = me.timeZone;
		if (me?.currency) currency = me.currency;
	} catch {
		/* keep UTC; the reports below say if the token is bad */
	}
	const today = localDate(now, tz);
	const start7 = addDays(today, -6);
	const report = (start: string, end: string, granularity?: "DAILY") =>
		call("POST", "/reports/campaigns", {
			startTime: start,
			endTime: end,
			...(granularity ? { granularity, returnRowTotals: false } : { returnRowTotals: true }),
			selector: { orderBy: [{ field: "localSpend", sortOrder: "DESCENDING" }], pagination: { offset: 0, limit: 100 } },
			timeZone: "ORTZ",
			returnRecordsWithNoMetrics: true,
			returnGrandTotals: false,
		});
	const failures: string[] = [];
	const [t, w, dRep] = await Promise.all([
		report(today, today).catch((e) => (failures.push(`today: ${errMsg(e)}`), null)),
		report(start7, today).catch((e) => (failures.push(`7d: ${errMsg(e)}`), null)),
		report(start7, today, "DAILY").catch((e) => (failures.push(`daily: ${errMsg(e)}`), null)),
	]);
	const readAt = new Date().toISOString();
	const rows = (x: any): any[] => x?.data?.reportingDataResponse?.row ?? [];
	const m = (tot: any): Metric => metric(money(tot?.localSpend), n(tot?.taps), n(tot?.impressions), n(tot?.totalInstalls ?? tot?.installs ?? tot?.tapInstalls));
	const wBy = new Map(rows(w).map((r) => [String(r.metadata?.campaignId), r]));
	const campaigns: CampaignPulse[] = rows(t).map((r) => {
		const md = r.metadata ?? {};
		const id = String(md.campaignId);
		return {
			id,
			name: String(md.campaignName ?? id),
			status: String(md.campaignStatus ?? md.displayStatus ?? "UNKNOWN").toUpperCase(),
			servingStatus: md.servingStatus ? String(md.servingStatus).toUpperCase() : null,
			dailyBudget: md.dailyBudget ? round2(money(md.dailyBudget)) : null,
			today: m(r.total),
			last7: m(wBy.get(id)?.total),
			disapprovedAds: null,
		};
	});
	const todayM = t ? sumMetrics(campaigns.map((c) => c.today)) : null;
	const weekM = w ? sumMetrics(rows(w).map((r) => m(r.total))) : null;
	const days: TrendPoint[] = rows(dRep).flatMap((r) =>
		(r.granularity ?? []).map((g: any) => {
			const mm = m(g);
			return { date: String(g.date ?? "").slice(0, 10), spend: mm.spend, clicks: mm.clicks, impressions: mm.impressions, conversions: mm.conversions };
		}),
	);
	const dailyBudget = totalBudget(campaigns.map((c) => ({ status: c.status, servingStatus: c.servingStatus, budget: c.dailyBudget, budgetKey: null })));
	const a: AccountPulse = {
		...base,
		timeZone: tz,
		currency,
		status: failures.length === 0 ? "ok" : t || w ? "partial" : "error",
		error: failures.length ? failures.join(" | ") : null,
		todayDate: today,
		last7Start: start7,
		today: todayM,
		last7: weekM,
		trend: dRep ? densify(today, days) : [],
		dailyBudget,
		pace: pace(todayM?.spend ?? null, dailyBudget, dayElapsed(now, tz)),
		lastLeadAt: null,
		lastLeadBasis: null,
		campaigns,
		flags: [],
		readAt: { metrics: t || w ? readAt : null, lastLead: null },
		note: "Conversions = installs (Apple totalInstalls). Apple reports lag a few hours.",
	};
	a.flags = flagsFor(a);
	return a;
}

// ─────────────────────────── ChatGPT Ads (optional) ───────────────────────────

export async function readChatGpt(now: Date, f: typeof fetch = fetch): Promise<AccountPulse> {
	const tz = env("OPENAI_ADS_TIME_ZONE") || "UTC";
	const base = { id: "chatgpt-ads", platform: "chatgpt_ads" as const, name: env("OPENAI_ADS_LABEL") || "ChatGPT Ads", accountRef: "ads.openai.com", timeZone: tz, currency: "USD" };
	const key = env("OPENAI_ADS_API_KEY");
	if (!key) return unreadAccount(base, "not_configured", "OPENAI_ADS_API_KEY is not set", now);
	const today = localDate(now, tz);
	const start7 = addDays(today, -6);
	try {
		// developers.openai.com/ads/reporting: spend is in major units.
		const q = new URLSearchParams({ aggregation_level: "ad_account", time_granularity: "daily", limit: "100" });
		q.append("time_ranges[]", JSON.stringify({ type: "date_range", since: start7, until: today, timezone: tz }));
		for (const fld of ["readable_time", "impressions", "clicks", "spend"]) q.append("fields[]", fld);
		const r = await f(`https://api.ads.openai.com/v1/ad_account/insights?${q}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
		const j = (await r.json().catch(() => ({}))) as { data?: Record<string, unknown>[]; error?: { message?: string } };
		if (!r.ok || !Array.isArray(j.data)) throw new Error(`OpenAI Ads insights ${r.status}: ${j.error?.message ?? "no data"}`);
		const num = (row: Record<string, unknown>, k: string) => Number(row[k] ?? row[`ad_account.${k}`] ?? 0) || 0;
		const days = j.data.map((row) => ({ date: String(row.readable_time ?? row["metadata.readable_time"] ?? "").slice(0, 10), m: metric(num(row, "spend"), num(row, "clicks"), num(row, "impressions"), null) }));
		const todayM = sumMetrics(days.filter((d) => d.date === today).map((d) => d.m), false);
		const a: AccountPulse = {
			...base,
			status: "ok",
			error: null,
			todayDate: today,
			last7Start: start7,
			today: todayM,
			last7: sumMetrics(days.map((d) => d.m), false),
			trend: densify(today, days.map((d) => ({ date: d.date, spend: d.m.spend, clicks: d.m.clicks, impressions: d.m.impressions, conversions: null })), false),
			dailyBudget: null,
			pace: pace(todayM.spend, null, dayElapsed(now, tz)),
			lastLeadAt: null,
			lastLeadBasis: null,
			campaigns: [],
			flags: [],
			readAt: { metrics: new Date().toISOString(), lastLead: null },
			note: "The insights API has no daily budget.",
		};
		a.flags = flagsFor(a);
		return a;
	} catch (e) {
		return unreadAccount(base, "error", errMsg(e), now);
	}
}

// ─────────────────────────── all ───────────────────────────

export async function readAll(now = new Date(), f: typeof fetch = fetch): Promise<AccountPulse[]> {
	const specs = googleSpecs();
	const google: Promise<AccountPulse[]> = specs.length
		? googleToken(f).then(
				(tok) => Promise.all(specs.map((s) => readGoogle(s, now, tok, f))),
				(e) => specs.map((s) => unreadAccount({ id: s.id, platform: s.lsa ? "google_lsa" : "google_ads", name: s.name, accountRef: s.cid, timeZone: "UTC", currency: "USD" }, "error", errMsg(e), now)),
			)
		: Promise.resolve([]);
	const [g, apple, chat] = await Promise.all([
		google,
		appleConfigured() ? readApple(now, f).then((a) => [a]) : Promise.resolve([]),
		env("OPENAI_ADS_API_KEY") ? readChatGpt(now, f).then((a) => [a]) : Promise.resolve([]),
	]);
	return [...g, ...apple, ...chat];
}
