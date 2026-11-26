import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, dayElapsed, flagsFor, localDate, metric, pace, sumMetrics, totalBudget, totals, unreadAccount, ZERO, type AccountPulse, type CampaignPulse } from "./core";
import { appleClientSecret, googleSpecs, parseAccounts, wallToIso } from "./read";
import crypto from "node:crypto";

const camp = (p: Partial<CampaignPulse> = {}): CampaignPulse => ({ id: "1", name: "C", status: "ENABLED", servingStatus: "SERVING", dailyBudget: 10, today: ZERO, last7: ZERO, disapprovedAds: 0, ...p });
const acct = (p: Partial<AccountPulse> = {}) => ({ status: "ok" as const, error: null, today: metric(0, 0, 0, 0), dailyBudget: 10, campaigns: [] as CampaignPulse[], pace: { dayElapsed: 0.5, expectedByNow: 5, ratio: 0 }, ...p });

test("metric: cost per conversion only when conversions > 0; null conversions stay null", () => {
	assert.equal(metric(30, 3, 100, 2).costPerConversion, 15);
	assert.equal(metric(30, 3, 100, 0).costPerConversion, null);
	assert.equal(metric(30, 3, 100, null).conversions, null);
	assert.equal(sumMetrics([metric(1, 1, 1, null)], false).conversions, null);
	assert.deepEqual(sumMetrics([metric(1.111, 1, 10, 1), metric(2.222, 2, 20, 0)]), metric(3.333, 3, 30, 1));
});

test("dates: local day, elapsed share, 7-day start", () => {
	const now = new Date("2026-11-26T03:30:00Z"); // 10:30 PM ET Nov 25, 9:30 PM CT
	assert.equal(localDate(now, "America/New_York"), "2026-11-25");
	assert.equal(localDate(now, "UTC"), "2026-11-26");
	assert.ok(Math.abs(dayElapsed(now, "America/Chicago") - 21.5 / 24) < 0.001);
	assert.equal(addDays("2026-11-25", -6), "2026-11-19");
});

test("pace: null without a budget; ratio of spend to budget x elapsed", () => {
	assert.deepEqual(pace(5, null, 0.5), { dayElapsed: 0.5, expectedByNow: null, ratio: null });
	assert.equal(pace(15, 20, 0.5).ratio, 1.5);
});

test("flags: Google over 1x budget is amber, over 2x red; Apple over 1x red", () => {
	const a = acct({ today: metric(25, 1, 10, 0), dailyBudget: 20, pace: { dayElapsed: 0.8, expectedByNow: 16, ratio: 1.56 } });
	assert.equal(flagsFor(a, { budgetSlack: 2 })[0].level, "amber");
	assert.equal(flagsFor({ ...a, today: metric(41, 1, 10, 0) }, { budgetSlack: 2 })[0].level, "red");
	assert.equal(flagsFor(a)[0].level, "red");
});

test("flags: over pace needs 1.5x AND a quarter of the budget spent", () => {
	assert.equal(flagsFor(acct({ today: metric(2, 1, 1, 0), dailyBudget: 100, pace: { dayElapsed: 0.01, expectedByNow: 1, ratio: 2 } })).length, 0);
	const f = flagsFor(acct({ today: metric(30, 1, 1, 0), dailyBudget: 100, pace: { dayElapsed: 0.2, expectedByNow: 20, ratio: 1.5 } }));
	assert.equal(f[0].code, "over_pace");
});

test("flags: zero impressions only on enabled, serving, after 9 AM, and not when disabled for LSA", () => {
	const camps = [camp({ name: "on" }), camp({ name: "pending", servingStatus: "PENDING" }), camp({ name: "paused", status: "PAUSED" }), camp({ name: "spent", today: metric(1, 1, 5, 0) })];
	const late = acct({ campaigns: camps, pace: { dayElapsed: 0.5, expectedByNow: 5, ratio: 0 } });
	assert.deepEqual(flagsFor(late).map((f) => f.message), ["on: 0 impressions today (enabled)"]);
	assert.equal(flagsFor({ ...late, pace: { dayElapsed: 0.3, expectedByNow: 3, ratio: 0 } }).length, 0);
	assert.equal(flagsFor(late, { zeroImpressions: false }).length, 0);
});

test("flags: disapproved ads and failed reads surface; a failed read is never a quiet zero", () => {
	assert.equal(flagsFor(acct({ campaigns: [camp({ disapprovedAds: 2, today: metric(1, 1, 5, 0) })] }))[0].message, "2 disapproved ads in enabled ad groups");
	const u = unreadAccount({ id: "x", platform: "google_ads", name: "X", accountRef: "1", timeZone: "UTC", currency: "USD" }, "error", "GAQL 403", new Date());
	assert.equal(u.today, null);
	assert.equal(u.flags[0].code, "read_failed");
	assert.equal(unreadAccount({ id: "y", platform: "chatgpt_ads", name: "Y", accountRef: "1", timeZone: "UTC", currency: "USD" }, "not_configured", "no key", new Date()).flags.length, 0);
});

test("totalBudget: enabled only, shared budget once, pending/ended skipped", () => {
	assert.equal(
		totalBudget([
			{ status: "ENABLED", servingStatus: "SERVING", budget: 10, budgetKey: "b1" },
			{ status: "ENABLED", servingStatus: "SERVING", budget: 10, budgetKey: "b1" },
			{ status: "ENABLED", servingStatus: "PENDING", budget: 10, budgetKey: "b2" },
			{ status: "PAUSED", servingStatus: "SERVING", budget: 55, budgetKey: "b3" },
			{ status: "RUNNING", servingStatus: "RUNNING", budget: 5, budgetKey: null },
		]),
		15,
	);
	assert.equal(totalBudget([]), null);
});

test("totals: unread accounts add nothing and are not counted as read", () => {
	const u = unreadAccount({ id: "x", platform: "chatgpt_ads", name: "X", accountRef: "1", timeZone: "UTC", currency: "USD" }, "not_configured", "no key", new Date());
	const ok = { ...u, status: "ok" as const, today: metric(5, 1, 1, 0), last7: metric(9, 1, 1, 0) };
	assert.deepEqual(totals([u, ok]), { todaySpend: 5, last7Spend: 9, accountsRead: 1, accountsTotal: 2, redFlags: 0 });
});

test("parseAccounts + googleSpecs: labels, dashes, MCC header only where it belongs", () => {
	assert.deepEqual(parseAccounts("123-456-7890:Search, 2345678901 ,bad:x"), [{ cid: "1234567890", label: "Search" }, { cid: "2345678901", label: null }]);
	const specs = googleSpecs({ GOOGLE_ADS_ACCOUNTS: "1234567890:Search", GOOGLE_ADS_LSA_ACCOUNTS: "3456789012:Local", GOOGLE_ADS_LOGIN_CUSTOMER_ID: "999-999-9999" });
	assert.deepEqual(specs.map((s) => [s.cid, s.lsa, s.login, s.name]), [["1234567890", false, "9999999999", "Search"], ["3456789012", true, null, "Local"]]);
	const scoped = googleSpecs({ GOOGLE_ADS_ACCOUNTS: "1234567890,2345678901", GOOGLE_ADS_LOGIN_CUSTOMER_ID: "9999999999", GOOGLE_ADS_MCC_CHILDREN: "2345678901" });
	assert.deepEqual(scoped.map((s) => s.login), [null, "9999999999"]);
	assert.equal(googleSpecs({ GOOGLE_ADS_ACCOUNTS: "1234567890" })[0].login, null);
});

test("wallToIso: Chicago wall time to an instant, DST-aware", () => {
	assert.equal(wallToIso("2026-09-21 14:37:05", "America/Chicago"), "2026-09-21T19:37:05.000Z");
	assert.equal(wallToIso("2026-12-01 14:00:00", "America/Chicago"), "2026-12-01T20:00:00.000Z");
	assert.equal(wallToIso("garbage", "America/Chicago"), null);
});

test("appleClientSecret: verifiable ES256 JWT with Apple's claims", () => {
	const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const pem = privateKey.export({ type: "sec1", format: "pem" }).toString();
	const jwt = appleClientSecret(pem, { clientId: "SEARCHADS.test", teamId: "SEARCHADS.test", keyId: "kid" }, 1_000);
	const [h, b, s] = jwt.split(".");
	assert.ok(crypto.verify("sha256", Buffer.from(`${h}.${b}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")));
	const claims = JSON.parse(Buffer.from(b, "base64url").toString());
	assert.equal(claims.aud, "https://appleid.apple.com");
	assert.equal(claims.exp - claims.iat, 3600);
	assert.equal(JSON.parse(Buffer.from(h, "base64url").toString()).alg, "ES256");
});

test("densify: 7 dense days oldest first, merges same-day rows, null conversions kept", async () => {
	const { densify } = await import("./core");
	const t = densify("2026-11-25", [
		{ date: "2026-11-25", spend: 1.005, clicks: 1, impressions: 3, conversions: 1 },
		{ date: "2026-11-25", spend: 2, clicks: 0, impressions: 2, conversions: 0 },
		{ date: "2026-11-01", spend: 99, clicks: 9, impressions: 9, conversions: 9 },
	]);
	assert.equal(t.length, 7);
	assert.equal(t[0].date, "2026-11-19");
	assert.deepEqual(t[6], { date: "2026-11-25", spend: 3.01, clicks: 1, impressions: 5, conversions: 1 });
	assert.equal(t.reduce((s, p) => s + p.spend, 0), 3.01);
	assert.equal(densify("2026-11-25", [], false)[0].conversions, null);
});
