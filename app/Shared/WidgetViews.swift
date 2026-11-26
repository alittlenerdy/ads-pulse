import SwiftUI
import WidgetKit

struct PulseEntry: TimelineEntry {
    let date: Date
    let snapshot: Snapshot?
    let error: String?
}

struct PulseWidgetView: View {
    let entry: PulseEntry
    var familyOverride: WidgetFamily? = nil
    @Environment(\.widgetFamily) private var envFamily
    private var family: WidgetFamily { familyOverride ?? envFamily }

    var body: some View {
        if let p = entry.snapshot?.pulse {
            switch family {
            case .systemSmall: small(p)
            case .systemLarge: large(p)
            default: medium(p)
            }
        } else {
            VStack(alignment: .leading) {
                Text("Ads Pulse").font(.headline)
                Text(entry.error ?? "Open Ads Pulse to load.").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func small(_ p: Pulse) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Ads today").font(.caption).foregroundStyle(.secondary)
                Spacer()
                if p.totals.redFlags > 0 {
                    Label("\(p.totals.redFlags)", systemImage: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(.red)
                }
            }
            Text(Fmt.usd(p.totals.todaySpend, cents: true)).font(.system(size: 24, weight: .semibold)).monospacedDigit().minimumScaleFactor(0.6)
            Text("7d \(Fmt.usd(p.totals.last7Spend))").font(.caption).foregroundStyle(.secondary)
            Spacer(minLength: 2)
            ForEach(p.accounts.prefix(3)) { a in
                HStack(spacing: 4) {
                    Circle().fill(color(a)).frame(width: 6, height: 6)
                    Text(short(a.name)).lineLimit(1)
                    Spacer()
                    Text(a.unread ? "n/a" : Fmt.usdShort(a.today?.spend ?? 0)).monospacedDigit()
                }
                .font(.caption2)
            }
            footer
        }
    }

    private func medium(_ p: Pulse) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(Fmt.usd(p.totals.todaySpend, cents: true)).font(.system(size: 20, weight: .semibold)).monospacedDigit()
                Text("today · 7d \(Fmt.usd(p.totals.last7Spend))").font(.caption).foregroundStyle(.secondary)
                Spacer()
                if p.totals.redFlags > 0 {
                    Label("\(p.totals.redFlags)", systemImage: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(.red)
                }
            }
            ForEach(p.accounts) { a in
                HStack(spacing: 5) {
                    Circle().fill(color(a)).frame(width: 6, height: 6)
                    Text(a.name).lineLimit(1)
                    Spacer()
                    if a.unread {
                        Text(a.status == "no_api" ? "no API" : "n/a").foregroundStyle(.secondary)
                    } else {
                        Text("\(Fmt.int(a.today?.clicks))c").foregroundStyle(.secondary).monospacedDigit()
                        Text(a.dailyBudget.map { "\(Fmt.usdShort(a.today?.spend ?? 0))/\(Fmt.usdShort($0))" } ?? Fmt.usd(a.today?.spend, cents: true))
                            .monospacedDigit()
                    }
                }
                .font(.caption)
                if let f = a.redFlags.first {
                    Text(f.message).font(.caption2).foregroundStyle(.red).lineLimit(1).padding(.leading, 11)
                }
            }
            Spacer(minLength: 0)
            footer
        }
    }

    private func large(_ p: Pulse) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 0) {
                    Text("Ads today").font(.caption).foregroundStyle(.secondary)
                    Text(Fmt.usd(p.totals.todaySpend, cents: true)).font(.system(size: 26, weight: .semibold)).monospacedDigit()
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 0) {
                    Text("7 days").font(.caption).foregroundStyle(.secondary)
                    Text(Fmt.usd(p.totals.last7Spend)).font(.headline).monospacedDigit()
                }
            }
            if p.totals.redFlags > 0 {
                Label("\(p.totals.redFlags) red flag\(p.totals.redFlags == 1 ? "" : "s")", systemImage: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(.red)
            }
            SpendSparkline(points: p.combinedTrend, color: .accentColor).frame(height: 64)
            Text("all accounts, spend per day, 7 days").font(.system(size: 9)).foregroundStyle(.tertiary)
            Divider()
            ForEach(p.accounts) { a in
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Circle().fill(color(a)).frame(width: 6, height: 6)
                        Text(a.name).font(.caption).lineLimit(1)
                        Spacer(minLength: 4)
                        if a.unread {
                            Text(a.status == "no_api" ? "no API" : "n/a").font(.caption).foregroundStyle(.secondary)
                        } else {
                            SpendSparkline(points: a.series, color: a.tint).frame(width: 62, height: 18)
                            Text(a.dailyBudget.map { "\(Fmt.usdShort(a.today?.spend ?? 0))/\(Fmt.usdShort($0))" } ?? Fmt.usd(a.today?.spend, cents: true))
                                .font(.caption).monospacedDigit().frame(minWidth: 62, alignment: .trailing)
                        }
                    }
                    if let f = a.redFlags.first {
                        Text(f.message).font(.caption2).foregroundStyle(.red).lineLimit(1).padding(.leading, 12)
                    }
                }
            }
            Spacer(minLength: 0)
            footer
        }
    }

    private var footer: some View {
        Text("read \(Fmt.ago(Fmt.iso(entry.snapshot?.pulse.generatedAt), now: entry.date))")
            .font(.system(size: 9)).foregroundStyle(.tertiary)
    }

    private func short(_ n: String) -> String { n.replacingOccurrences(of: " · ", with: " ") }

    private func color(_ a: Account) -> Color {
        a.hasRed ? .red : a.hasAmber ? .orange : a.unread ? .gray : .green
    }
}

