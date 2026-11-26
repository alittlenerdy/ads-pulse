import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, tokenMatches } from "./handler";
import { demoAccounts } from "./demo";

test("tokenMatches: unset expected token is closed", () => {
	assert.equal(tokenMatches("x", undefined), false);
	assert.equal(tokenMatches(undefined, "x"), false);
	assert.equal(tokenMatches("ab", "abc"), false);
	assert.equal(tokenMatches("abc", "abc"), true);
});

test("handle: 401 without the token; demo data with it", async () => {
	process.env.ADS_PULSE_TOKEN = "t0k3n";
	assert.equal((await handle(undefined, new URL("http://x/api/ads-pulse"))).status, 401);
	assert.equal((await handle("Bearer nope", new URL("http://x/api/ads-pulse"))).status, 401);
	const ok = await handle("Bearer t0k3n", new URL("http://x/api/ads-pulse?demo=1"));
	assert.equal(ok.status, 200);
	const body = ok.body as { accounts: unknown[]; totals: { accountsTotal: number } };
	assert.equal(body.totals.accountsTotal, body.accounts.length);
});

test("demo: 5 accounts, dense 7-day trends, one red flag shows, deterministic per day", () => {
	const now = new Date("2026-11-25T20:00:00Z");
	const a = demoAccounts(now);
	assert.equal(a.length, 5);
	for (const x of a) assert.equal(x.trend.length, 7);
	assert.ok(a.some((x) => x.flags.some((f) => f.level === "red")));
	assert.deepEqual(demoAccounts(now), a);
	const search = a[0];
	assert.equal(Math.round(search.trend.reduce((s, p) => s + p.spend, 0) * 100) / 100, search.last7!.spend);
});
