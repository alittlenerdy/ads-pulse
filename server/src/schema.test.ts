import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { totals } from "./core";
import { demoAccounts } from "./demo";

/** Minimal check that demo output carries every key schema.json requires (no validator dependency). */
test("demo response carries every required key in schema.json", () => {
	const schema = JSON.parse(fs.readFileSync(path.join(__dirname, "../../schema.json"), "utf8"));
	const accounts = demoAccounts(new Date("2026-11-25T18:00:00Z"));
	const body = { generatedAt: "x", cacheTtlSec: 0, cached: false, totals: totals(accounts), accounts };
	const req = (def: { required?: string[] }, obj: Record<string, unknown>, where: string) => {
		for (const k of def.required ?? []) assert.ok(k in obj, `${where} missing ${k}`);
	};
	req(schema, body, "response");
	req(schema.properties.totals, body.totals, "totals");
	for (const a of accounts) {
		req(schema.$defs.account, a as unknown as Record<string, unknown>, a.id);
		for (const c of a.campaigns) req(schema.$defs.campaign, c as unknown as Record<string, unknown>, `${a.id}/${c.id}`);
		for (const p of a.trend) req(schema.$defs.trendPoint, p as unknown as Record<string, unknown>, `${a.id} trend`);
	}
});
