/**
 * Fake accounts for demo mode (ADS_PULSE_DEMO=1 on the server; the app has its own copy).
 * Deterministic for a given day so screenshots are stable. No real account data.
 */
import { type AccountPulse, type CampaignPulse, type TrendPoint, addDays, dayElapsed, flagsFor, localDate, metric, pace, sumMetrics } from "./core";

function rng(seed: number) {
	let s = seed >>> 0;
	return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

interface DemoSpec {
	id: string;
	platform: AccountPulse["platform"];
	name: string;
	ref: string;
	campaigns: { name: string; budget: number; pending?: boolean }[];
	cpc: number;
	cvr: number;
	overBudget?: boolean;
}

const SPECS: DemoSpec[] = [
	{ id: "demo-search", platform: "google_ads", name: "Acme Plumbing · Search", ref: "000-000-0001", cpc: 9.4, cvr: 0.09, campaigns: [{ name: "Search | Metro | Emergency", budget: 120 }, { name: "Search | Metro | Water heaters", budget: 45 }, { name: "Search | Suburbs | General", budget: 30 }] },
	{ id: "demo-lsa", platform: "google_lsa", name: "Acme Plumbing · LSA", ref: "000-000-0002", cpc: 28, cvr: 0.6, campaigns: [{ name: "Local Services", budget: 40 }] },
	{ id: "demo-brand", platform: "google_ads", name: "Northwind Coffee · Google Ads", ref: "000-000-0003", cpc: 1.1, cvr: 0.04, campaigns: [{ name: "Brand | Exact", budget: 15 }, { name: "Shop | Beans", budget: 25 }, { name: "Holiday gift test", budget: 20, pending: true }] },
	{ id: "demo-apple", platform: "apple_ads", name: "Tally Notes · Apple Ads", ref: "org 000001", cpc: 1.7, cvr: 0.35, overBudget: true, campaigns: [{ name: "US Search: note taking", budget: 10 }] },
	{ id: "demo-chatgpt", platform: "chatgpt_ads", name: "Contoso Tools · ChatGPT Ads", ref: "ads.openai.com", cpc: 0.55, cvr: 0, campaigns: [] },
];

export function demoAccounts(now = new Date(), timeZone = "America/Chicago"): AccountPulse[] {
	const today = localDate(now, timeZone);
	const elapsed = dayElapsed(now, timeZone);
	return SPECS.map((s, si) => {
		const rand = rng(Number(today.replace(/-/g, "")) * 7 + si);
		const google = s.platform === "google_ads" || s.platform === "google_lsa";
		const known = s.platform !== "chatgpt_ads";
		const day = (budget: number, i: number, pending = false): TrendPoint => {
			const share = i === 0 ? elapsed : 1;
			const factor = s.overBudget && i === 0 ? 1.3 / Math.max(elapsed, 0.01) : 0.7 + rand() * 0.55;
			const spend = pending ? 0 : Math.round(budget * factor * share * 100) / 100;
			const clicks = Math.round(spend / s.cpc);
			return { date: addDays(today, -i), spend, clicks, impressions: Math.round(clicks * (12 + rand() * 20)), conversions: known ? Math.round(clicks * s.cvr * (0.5 + rand())) : null };
		};
		const perCampaign = s.campaigns.map((c) => [6, 5, 4, 3, 2, 1, 0].map((i) => day(c.budget, i, c.pending)));
		const series: TrendPoint[] = s.campaigns.length
			? [0, 1, 2, 3, 4, 5, 6].map((k) => ({
					date: addDays(today, k - 6),
					spend: Math.round(perCampaign.reduce((x, d) => x + d[k].spend, 0) * 100) / 100,
					clicks: perCampaign.reduce((x, d) => x + d[k].clicks, 0),
					impressions: perCampaign.reduce((x, d) => x + d[k].impressions, 0),
					conversions: perCampaign.reduce((x, d) => x + (d[k].conversions ?? 0), 0),
				}))
			: [6, 5, 4, 3, 2, 1, 0].map((i) => day(18, i));
		const m = (d: TrendPoint) => metric(d.spend, d.clicks, d.impressions, d.conversions);
		const campaigns: CampaignPulse[] = s.campaigns.map((c, ci) => ({
			id: `${s.id}-${ci}`,
			name: c.name,
			status: "ENABLED",
			servingStatus: c.pending ? "PENDING" : s.platform === "apple_ads" ? "RUNNING" : "SERVING",
			dailyBudget: c.budget,
			today: m(perCampaign[ci][6]),
			last7: sumMetrics(perCampaign[ci].map(m)),
			disapprovedAds: s.platform === "google_ads" ? (s.id === "demo-brand" && ci === 1 ? 1 : 0) : null,
		}));
		const budget = s.campaigns.filter((c) => !c.pending).reduce((x, c) => x + c.budget, 0) || null;
		const todayM = m(series[6]);
		const a: AccountPulse = {
			id: s.id,
			platform: s.platform,
			name: s.name,
			accountRef: s.ref,
			timeZone,
			currency: "USD",
			status: "ok",
			error: null,
			todayDate: today,
			last7Start: addDays(today, -6),
			today: todayM,
			last7: sumMetrics(series.map(m), known),
			trend: series,
			dailyBudget: budget,
			pace: pace(todayM.spend, budget, elapsed),
			lastLeadAt: s.platform === "google_lsa" ? new Date(now.getTime() - 3.2 * 3600_000).toISOString() : s.platform === "google_ads" ? addDays(today, -1) : null,
			lastLeadBasis: s.platform === "google_lsa" ? "LSA lead created" : s.platform === "google_ads" ? "last day with a conversion (by conversion date, 90-day window)" : null,
			campaigns,
			flags: [],
			readAt: { metrics: now.toISOString(), lastLead: now.toISOString() },
			note: "Demo data. Nothing here is a real account.",
		};
		a.flags = flagsFor(a, { budgetSlack: google ? 2 : 1, zeroImpressions: s.platform !== "google_lsa" });
		return a;
	});
}
