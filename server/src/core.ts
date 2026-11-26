/**
 * Ads Pulse response schema + pure helpers (no I/O). The macOS app decodes exactly
 * this shape; schema.json at the repo root is the same contract as JSON Schema.
 *
 * A number that could not be read is `null` with the reason in `error`, never 0:
 * a zero from a failed or wrong-account read looks like "no spend".
 */

export type Platform = "google_ads" | "google_lsa" | "apple_ads" | "chatgpt_ads";

export interface Metric {
	spend: number;
	clicks: number;
	impressions: number;
	/** null where the platform has no conversion count we read (ChatGPT Ads). */
	conversions: number | null;
	costPerConversion: number | null;
}

export interface CampaignPulse {
	id: string;
	name: string;
	/** Platform status, uppercased (ENABLED / PAUSED / RUNNING / ON_HOLD ...). */
	status: string;
	/** Google serving_status or Apple servingStatus where read. */
	servingStatus: string | null;
	dailyBudget: number | null;
	today: Metric;
	last7: Metric;
	disapprovedAds: number | null;
}

/** One account-local day of the 7-day window. Every day is present (zeros filled). */
export interface TrendPoint {
	date: string;
	spend: number;
	clicks: number;
	impressions: number;
	conversions: number | null;
}

/** Dense 7-day series ending `today`: Google omits zero days, so missing dates become zeros. */
export function densify(today: string, rows: TrendPoint[], conversionsKnown = true): TrendPoint[] {
	const by = new Map<string, TrendPoint>();
	for (const r of rows) {
		const cur = by.get(r.date) ?? { date: r.date, spend: 0, clicks: 0, impressions: 0, conversions: conversionsKnown ? 0 : null };
		cur.spend += r.spend;
		cur.clicks += r.clicks;
		cur.impressions += r.impressions;
		if (conversionsKnown) cur.conversions = (cur.conversions ?? 0) + (r.conversions ?? 0);
		by.set(r.date, cur);
	}
	const out: TrendPoint[] = [];
	for (let i = 6; i >= 0; i--) {
		const d = addDays(today, -i);
		const p = by.get(d) ?? { date: d, spend: 0, clicks: 0, impressions: 0, conversions: conversionsKnown ? 0 : null };
		out.push({ ...p, spend: round2(p.spend), conversions: p.conversions == null ? null : round2(p.conversions) });
	}
	return out;
}

export type FlagCode = "over_pace" | "over_budget" | "zero_impressions" | "disapproved_ads" | "read_failed";

export interface Flag {
	level: "red" | "amber";
	code: FlagCode;
	message: string;
}

export interface AccountPulse {
	id: string;
	platform: Platform;
	name: string;
	/** Platform account id as the platform shows it (customer id, org id). */
	accountRef: string;
	timeZone: string;
	currency: string;
	/** ok = every block read; partial = some failed (see error); no_api / not_configured = nothing read. */
	status: "ok" | "partial" | "error" | "no_api" | "not_configured";
	error: string | null;
	/** Account-local calendar date "today" was read for. */
	todayDate: string;
	/** The 7 days ending today, inclusive (today + 6 prior), account time. */
	last7Start: string;
	today: Metric | null;
	last7: Metric | null;
	/** Daily series for the 7-day window, oldest first; [] when not read. */
	trend: TrendPoint[];
	/** Sum of ENABLED campaigns' daily budgets (shared budgets counted once). */
	dailyBudget: number | null;
	pace: { dayElapsed: number; expectedByNow: number | null; ratio: number | null };
	lastLeadAt: string | null;
	/** What lastLeadAt measures, in words (e.g. "LSA lead created", "conversion date"). */
	lastLeadBasis: string | null;
	campaigns: CampaignPulse[];
	flags: Flag[];
	/** ISO time each block was read. */
	readAt: { metrics: string | null; lastLead: string | null };
	note: string | null;
}

export interface PulseResponse {
	generatedAt: string;
	cacheTtlSec: number;
	cached: boolean;
	totals: { todaySpend: number; last7Spend: number; accountsRead: number; accountsTotal: number; redFlags: number };
	accounts: AccountPulse[];
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

export function metric(spend: number, clicks: number, impressions: number, conversions: number | null): Metric {
	return {
		spend: round2(spend),
		clicks,
		impressions,
		conversions: conversions == null ? null : round2(conversions),
		costPerConversion: conversions && conversions > 0 ? round2(spend / conversions) : null,
	};
}

export const ZERO: Metric = metric(0, 0, 0, 0);

export function sumMetrics(ms: Metric[], conversionsKnown = true): Metric {
	const spend = ms.reduce((s, m) => s + m.spend, 0);
	const clicks = ms.reduce((s, m) => s + m.clicks, 0);
	const impressions = ms.reduce((s, m) => s + m.impressions, 0);
	const conv = conversionsKnown ? ms.reduce((s, m) => s + (m.conversions ?? 0), 0) : null;
	return metric(spend, clicks, impressions, conv);
}

/** "YYYY-MM-DD" for `now` in an IANA time zone. */
export function localDate(now: Date, timeZone: string): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Fraction of the local day elapsed, 0..1. */
export function dayElapsed(now: Date, timeZone: string): number {
	const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(now);
	const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
	const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
	return Math.min(1, Math.max(0, (h * 60 + m) / 1440));
}

export function addDays(date: string, n: number): string {
	return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export function pace(spendToday: number | null, budget: number | null, elapsed: number) {
	if (budget == null || budget <= 0 || spendToday == null) return { dayElapsed: round2(elapsed), expectedByNow: null, ratio: null };
	const expected = budget * elapsed;
	return { dayElapsed: round2(elapsed), expectedByNow: round2(expected), ratio: expected > 0 ? round2(spendToday / expected) : null };
}

/** Status values that mean "this campaign is switched on and should be serving". */
const ON = new Set(["ENABLED", "RUNNING"]);
/** Serving statuses under which 0 impressions is expected, not a fault. */
const QUIET_SERVING = new Set(["PENDING", "ENDED", "SUSPENDED", "NONE", "NOT_RUNNING", "CAMPAIGN_ON_HOLD", "ON_HOLD"]);

/** Before this share of the local day, 0 impressions is normal (9 AM). */
export const ZERO_IMPR_AFTER = 9 / 24;
/** Red when today's spend runs this far ahead of budget × day elapsed... */
export const OVER_PACE_RATIO = 1.5;
/** ...and is at least this share of the daily budget (ignores $2 at 12:30 AM). */
export const OVER_PACE_MIN_SHARE = 0.25;

export interface FlagOpts {
	/** Google may spend up to 2x a daily budget on one day (support.google.com/google-ads/answer/2375423); Apple caps at 1x. */
	budgetSlack?: number;
	/** LSA reports no dependable impressions through GAQL; skip the zero check there. */
	zeroImpressions?: boolean;
}

export function flagsFor(a: Pick<AccountPulse, "status" | "error" | "today" | "dailyBudget" | "campaigns" | "pace">, opts: FlagOpts = {}): Flag[] {
	const slack = opts.budgetSlack ?? 1;
	const flags: Flag[] = [];
	if (a.status === "error" || a.status === "partial") {
		flags.push({ level: a.status === "error" ? "red" : "amber", code: "read_failed", message: a.error ?? "read failed" });
	}
	const spend = a.today?.spend ?? null;
	if (spend != null && a.dailyBudget && a.dailyBudget > 0) {
		if (spend > a.dailyBudget) {
			const hard = spend > a.dailyBudget * slack;
			const why = !hard && slack > 1 ? ` (Google allows up to ${slack}x on a day)` : "";
			flags.push({ level: hard ? "red" : "amber", code: "over_budget", message: `$${spend.toFixed(2)} today vs $${a.dailyBudget.toFixed(2)} daily budget${why}` });
		} else if (a.pace.ratio != null && a.pace.ratio >= OVER_PACE_RATIO && spend >= a.dailyBudget * OVER_PACE_MIN_SHARE) {
			flags.push({ level: "red", code: "over_pace", message: `${a.pace.ratio.toFixed(1)}x budget pace ($${spend.toFixed(2)} by ${Math.round(a.pace.dayElapsed * 100)}% of the day)` });
		}
	}
	if (opts.zeroImpressions !== false && a.pace.dayElapsed >= ZERO_IMPR_AFTER) {
		for (const c of a.campaigns) {
			if (!ON.has(c.status)) continue;
			if (c.servingStatus && QUIET_SERVING.has(c.servingStatus)) continue;
			if (c.dailyBudget != null && c.dailyBudget <= 0) continue;
			if (c.today.impressions === 0) flags.push({ level: "red", code: "zero_impressions", message: `${c.name}: 0 impressions today (enabled)` });
		}
	}
	const dis = a.campaigns.reduce((s, c) => s + (c.disapprovedAds ?? 0), 0);
	if (dis > 0) flags.push({ level: "red", code: "disapproved_ads", message: `${dis} disapproved ad${dis === 1 ? "" : "s"} in enabled ad groups` });
	return flags;
}

/** Sum enabled campaigns' budgets, counting a shared budget once. */
export function totalBudget(rows: { status: string; servingStatus: string | null; budget: number | null; budgetKey: string | null }[]): number | null {
	const seen = new Set<string>();
	let total = 0;
	let any = false;
	for (const r of rows) {
		if (!ON.has(r.status) || r.budget == null) continue;
		if (r.servingStatus && (r.servingStatus === "ENDED" || r.servingStatus === "PENDING")) continue;
		if (r.budgetKey) {
			if (seen.has(r.budgetKey)) continue;
			seen.add(r.budgetKey);
		}
		total += r.budget;
		any = true;
	}
	return any ? round2(total) : null;
}

export function totals(accounts: AccountPulse[]): PulseResponse["totals"] {
	return {
		todaySpend: round2(accounts.reduce((s, a) => s + (a.today?.spend ?? 0), 0)),
		last7Spend: round2(accounts.reduce((s, a) => s + (a.last7?.spend ?? 0), 0)),
		accountsRead: accounts.filter((a) => a.status === "ok" || a.status === "partial").length,
		accountsTotal: accounts.length,
		redFlags: accounts.reduce((s, a) => s + a.flags.filter((f) => f.level === "red").length, 0),
	};
}

/** An account we cannot read at all (no API, or no key on the server). */
export function unreadAccount(base: Pick<AccountPulse, "id" | "platform" | "name" | "accountRef" | "timeZone" | "currency">, status: "no_api" | "not_configured" | "error", why: string, now: Date): AccountPulse {
	const today = localDate(now, base.timeZone);
	const a: AccountPulse = {
		...base,
		status,
		error: why,
		todayDate: today,
		last7Start: addDays(today, -6),
		today: null,
		last7: null,
		trend: [],
		dailyBudget: null,
		pace: { dayElapsed: round2(dayElapsed(now, base.timeZone)), expectedByNow: null, ratio: null },
		lastLeadAt: null,
		lastLeadBasis: null,
		campaigns: [],
		flags: [],
		readAt: { metrics: null, lastLead: null },
		note: null,
	};
	a.flags = status === "error" ? flagsFor(a) : [];
	return a;
}
