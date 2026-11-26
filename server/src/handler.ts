/**
 * Framework-free request handler: bearer auth, in-memory cache (5 minutes by default), demo mode.
 * Used by src/server.ts (plain Node) and api/ads-pulse.ts (Vercel).
 */
import crypto from "node:crypto";
import { totals, type PulseResponse } from "./core";
import { demoAccounts } from "./demo";
import { readAll } from "./read";

const TTL = Number(process.env.ADS_PULSE_CACHE_SECONDS || 300);
let cache: { at: number; body: PulseResponse } | null = null;

export function tokenMatches(given: string | undefined, expected: string | undefined): boolean {
	if (!expected || !given) return false;
	const a = Buffer.from(given);
	const b = Buffer.from(expected);
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function handle(authHeader: string | undefined, url: URL): Promise<{ status: number; body: unknown }> {
	const given = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
	if (!tokenMatches(given, process.env.ADS_PULSE_TOKEN)) return { status: 401, body: { error: "Unauthorized" } };
	if (process.env.ADS_PULSE_DEMO === "1" || url.searchParams.get("demo") === "1") {
		const accounts = demoAccounts(new Date());
		const body: PulseResponse = { generatedAt: new Date().toISOString(), cacheTtlSec: 0, cached: false, totals: totals(accounts), accounts };
		return { status: 200, body };
	}
	const fresh = url.searchParams.get("fresh") === "1";
	if (!fresh && cache && Date.now() - cache.at < TTL * 1000) return { status: 200, body: { ...cache.body, cached: true } };
	const accounts = await readAll(new Date());
	const body: PulseResponse = { generatedAt: new Date().toISOString(), cacheTtlSec: TTL, cached: false, totals: totals(accounts), accounts };
	cache = { at: Date.now(), body };
	return { status: 200, body };
}
