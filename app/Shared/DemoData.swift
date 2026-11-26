import Foundation

/// Fake accounts for demo mode: first launch and screenshots work with no endpoint or keys.
/// Deterministic per calendar day. Same idea as server/src/demo.ts. No real account data.
enum DemoData {
    private struct Spec {
        let id, platform, name, ref: String
        let campaigns: [(String, Double, Bool)]   // name, daily budget, pending
        let cpc, cvr: Double
        var overBudget = false
    }

    private static let specs: [Spec] = [
        Spec(id: "demo-search", platform: "google_ads", name: "Acme Plumbing · Search", ref: "000-000-0001",
             campaigns: [("Search | Metro | Emergency", 120, false), ("Search | Metro | Water heaters", 45, false), ("Search | Suburbs | General", 30, false)], cpc: 9.4, cvr: 0.09),
        Spec(id: "demo-lsa", platform: "google_lsa", name: "Acme Plumbing · LSA", ref: "000-000-0002",
             campaigns: [("Local Services", 40, false)], cpc: 28, cvr: 0.6),
        Spec(id: "demo-brand", platform: "google_ads", name: "Northwind Coffee · Google Ads", ref: "000-000-0003",
             campaigns: [("Brand | Exact", 15, false), ("Shop | Beans", 25, false), ("Holiday gift test", 20, true)], cpc: 1.1, cvr: 0.04),
        Spec(id: "demo-apple", platform: "apple_ads", name: "Tally Notes · Apple Ads", ref: "org 000001",
             campaigns: [("US Search: note taking", 10, false)], cpc: 1.7, cvr: 0.35, overBudget: true),
        Spec(id: "demo-chatgpt", platform: "chatgpt_ads", name: "Contoso Tools · ChatGPT Ads", ref: "ads.openai.com",
             campaigns: [], cpc: 0.55, cvr: 0),
    ]

    private struct LCG {
        var s: UInt32
        mutating func next() -> Double { s = s &* 1664525 &+ 1013904223; return Double(s) / 4294967296 }
    }

    private static func ymd(_ d: Date) -> String {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = .current
        return f.string(from: d)
    }

    private static func m(_ spend: Double, _ clicks: Int, _ impr: Int, _ conv: Double?) -> Metric {
        let s = (spend * 100).rounded() / 100
        return Metric(spend: s, clicks: clicks, impressions: impr, conversions: conv, costPerConversion: (conv ?? 0) > 0 ? ((s / conv!) * 100).rounded() / 100 : nil)
    }

    private static func sum(_ ps: [TrendPoint], known: Bool) -> Metric {
        m(ps.reduce(0) { $0 + $1.spend }, ps.reduce(0) { $0 + $1.clicks }, ps.reduce(0) { $0 + $1.impressions },
          known ? ps.reduce(0) { $0 + ($1.conversions ?? 0) } : nil)
    }

    static func pulse(now: Date = Date()) -> Pulse {
        let cal = Calendar.current
        let start = cal.startOfDay(for: now)
        let elapsed = max(0.01, now.timeIntervalSince(start) / 86400)
        let today = ymd(now)
        let dates = (0..<7).map { ymd(cal.date(byAdding: .day, value: $0 - 6, to: start)!) }
        let iso = ISO8601DateFormatter(); iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let nowIso = iso.string(from: now)

        var accounts: [Account] = []
        for (si, s) in specs.enumerated() {
            var rng = LCG(s: UInt32(truncatingIfNeeded: (Int(today.replacingOccurrences(of: "-", with: "")) ?? 1) * 7 + si))
            let known = s.platform != "chatgpt_ads"
            func day(_ budget: Double, _ k: Int, _ pending: Bool) -> TrendPoint {
                let share = k == 6 ? elapsed : 1
                let factor = s.overBudget && k == 6 ? 1.3 / elapsed : 0.7 + rng.next() * 0.55
                let spend = pending ? 0 : ((budget * factor * share) * 100).rounded() / 100
                let clicks = Int((spend / s.cpc).rounded())
                return TrendPoint(date: dates[k], spend: spend, clicks: clicks, impressions: Int(Double(clicks) * (12 + rng.next() * 20)),
                                  conversions: known ? (Double(clicks) * s.cvr * (0.5 + rng.next())).rounded() : nil)
            }
            let per = s.campaigns.map { c in (0..<7).map { day(c.1, $0, c.2) } }
            let series: [TrendPoint] = s.campaigns.isEmpty
                ? (0..<7).map { day(18, $0, false) }
                : (0..<7).map { k in
                    TrendPoint(date: dates[k], spend: (per.reduce(0) { $0 + $1[k].spend } * 100).rounded() / 100,
                               clicks: per.reduce(0) { $0 + $1[k].clicks }, impressions: per.reduce(0) { $0 + $1[k].impressions },
                               conversions: per.reduce(0) { $0 + ($1[k].conversions ?? 0) })
                }
            let campaigns = s.campaigns.enumerated().map { ci, c in
                Campaign(id: "\(s.id)-\(ci)", name: c.0, status: "ENABLED",
                         servingStatus: c.2 ? "PENDING" : s.platform == "apple_ads" ? "RUNNING" : "SERVING",
                         dailyBudget: c.1, today: sum([per[ci][6]], known: true), last7: sum(per[ci], known: true),
                         disapprovedAds: s.platform == "google_ads" ? (s.id == "demo-brand" && ci == 1 ? 1 : 0) : nil)
            }
            let budget = s.campaigns.filter { !$0.2 }.reduce(0) { $0 + $1.1 }
            let todayM = sum([series[6]], known: known)
            let ratio = budget > 0 ? (todayM.spend / (budget * elapsed) * 100).rounded() / 100 : nil
            var flags: [Flag] = []
            if budget > 0, todayM.spend > budget {
                let slack = s.platform.hasPrefix("google") ? 2.0 : 1.0
                let hard = todayM.spend > budget * slack
                flags.append(Flag(level: hard ? "red" : "amber", code: "over_budget",
                                  message: "\(Fmt.usd(todayM.spend, cents: true)) today vs \(Fmt.usd(budget, cents: true)) daily budget\(hard ? "" : " (Google allows up to 2x on a day)")"))
            }
            if campaigns.contains(where: { ($0.disapprovedAds ?? 0) > 0 }) {
                flags.append(Flag(level: "red", code: "disapproved_ads", message: "1 disapproved ad in enabled ad groups"))
            }
            let lastLead: String? = s.platform == "google_lsa" ? iso.string(from: now.addingTimeInterval(-3.2 * 3600)) : s.platform == "google_ads" ? dates[5] : nil
            accounts.append(Account(
                id: s.id, platform: s.platform, name: s.name, accountRef: s.ref, timeZone: TimeZone.current.identifier, currency: "USD",
                status: "ok", error: nil, todayDate: today, last7Start: dates[0], today: todayM, last7: sum(series, known: known),
                trend: series, dailyBudget: budget > 0 ? budget : nil,
                pace: Pace(dayElapsed: (elapsed * 100).rounded() / 100, expectedByNow: budget > 0 ? (budget * elapsed * 100).rounded() / 100 : nil, ratio: ratio),
                lastLeadAt: lastLead,
                lastLeadBasis: s.platform == "google_lsa" ? "LSA lead created" : s.platform == "google_ads" ? "last day with a conversion (by conversion date, 90-day window)" : nil,
                campaigns: campaigns, flags: flags, readAt: ReadAt(metrics: nowIso, lastLead: nowIso),
                note: "Demo data. Nothing here is a real account."))
        }
        let totals = Totals(
            todaySpend: (accounts.reduce(0) { $0 + ($1.today?.spend ?? 0) } * 100).rounded() / 100,
            last7Spend: (accounts.reduce(0) { $0 + ($1.last7?.spend ?? 0) } * 100).rounded() / 100,
            accountsRead: accounts.count, accountsTotal: accounts.count,
            redFlags: accounts.reduce(0) { $0 + $1.redFlags.count })
        return Pulse(generatedAt: nowIso, cached: false, totals: totals, accounts: accounts)
    }
}
