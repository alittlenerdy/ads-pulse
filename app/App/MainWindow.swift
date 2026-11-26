import SwiftUI
import Charts

struct MainWindow: View {
    @ObservedObject var model: PulseModel
    @Environment(\.openWindow) private var openWindow
    @State private var selection: String? = {
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--select"), i + 1 < args.count { return args[i + 1] }
        return "all"
    }()

    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                Label("All accounts", systemImage: "square.grid.2x2").tag("all")
                Section("Accounts") {
                    ForEach(model.pulse?.accounts ?? []) { a in
                        HStack {
                            Circle().fill(statusColor(a)).frame(width: 8, height: 8)
                            Text(a.name).lineLimit(1)
                            Spacer()
                            Text(a.unread ? "n/a" : Fmt.usdShort(a.today?.spend ?? 0)).foregroundStyle(.secondary).monospacedDigit()
                        }
                        .tag(a.id)
                    }
                }
            }
            .navigationSplitViewColumnWidth(min: 220, ideal: 250)
        } detail: {
            Group {
                if let p = model.pulse {
                    if let id = selection, id != "all", let a = p.accounts.first(where: { $0.id == id }) {
                        AccountDetail(account: a)
                    } else {
                        Overview(pulse: p, select: { selection = $0 })
                    }
                } else {
                    ContentUnavailableView(model.error ?? "Loading…", systemImage: "chart.line.uptrend.xyaxis")
                }
            }
            .toolbar {
                ToolbarItemGroup {
                    if let e = model.error { Label(e, systemImage: "exclamationmark.circle").foregroundStyle(.red) }
                    if AppConfig.demo { Text("Demo mode · fake data").foregroundStyle(.secondary).font(.caption) }
                    else if let p = model.pulse { Text("read \(Fmt.ago(Fmt.iso(p.generatedAt)))\(p.cached ? " · cached" : "")").foregroundStyle(.secondary).font(.caption) }
                    Button { Task { await model.refresh(fresh: true) } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                        .help("Read every account now (skips the 5-minute cache)")
                }
            }
        }
        .onAppear { if CommandLine.arguments.contains("--preview") { openWindow(id: "preview") } }
    }
}

func statusColor(_ a: Account) -> Color {
    a.hasRed ? .red : a.hasAmber ? .orange : a.unread ? .gray : .green
}

struct Overview: View {
    let pulse: Pulse
    let select: (String) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .bottom, spacing: 28) {
                    bigStat("Today", Fmt.usd(pulse.totals.todaySpend, cents: true))
                    bigStat("Last 7 days", Fmt.usd(pulse.totals.last7Spend))
                    bigStat("Accounts read", "\(pulse.totals.accountsRead)/\(pulse.totals.accountsTotal)")
                    bigStat("Red flags", "\(pulse.totals.redFlags)", color: pulse.totals.redFlags > 0 ? .red : .primary)
                    Spacer()
                }
                GroupBox("All accounts, spend per day") {
                    SpendSparkline(points: pulse.combinedTrend, color: .accentColor, showAxes: true).frame(height: 160).padding(.top, 6)
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 300), spacing: 14)], spacing: 14) {
                    ForEach(pulse.accounts) { a in
                        AccountCard(account: a).onTapGesture { select(a.id) }
                    }
                }
            }
            .padding(20)
        }
        .navigationTitle("Ads Pulse")
    }

    private func bigStat(_ label: String, _ value: String, color: Color = .primary) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.system(size: 28, weight: .semibold)).monospacedDigit().foregroundStyle(color)
        }
    }
}

struct AccountCard: View {
    let account: Account
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Circle().fill(statusColor(account)).frame(width: 8, height: 8)
                Text(account.name).font(.headline)
                Spacer()
                Text(account.unread ? statusWord(account) : Fmt.usd(account.today?.spend, cents: true)).font(.headline).monospacedDigit()
                    .foregroundStyle(account.unread ? .secondary : .primary)
            }
            if !account.unread {
                SpendSparkline(points: account.series, color: account.tint).frame(height: 54)
                HStack(spacing: 14) {
                    mini("7d", Fmt.usd(account.last7?.spend))
                    mini("clicks", Fmt.int(account.today?.clicks))
                    mini(convLabel(account), Fmt.conv(account.today?.conversions))
                    mini("budget", account.dailyBudget.map { Fmt.usd($0) } ?? "n/a")
                    mini("pace", account.pace.ratio.map { String(format: "%.2fx", $0) } ?? "n/a")
                }
            } else if let e = account.error {
                Text(e).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            ForEach(account.flags, id: \.self) { f in
                Label(f.message, systemImage: f.isRed ? "exclamationmark.triangle.fill" : "exclamationmark.circle")
                    .font(.caption).foregroundStyle(f.isRed ? .red : .orange).lineLimit(2)
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.primary.opacity(0.05)))
        .contentShape(Rectangle())
    }

    private func mini(_ l: String, _ v: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(l).font(.caption2).foregroundStyle(.secondary)
            Text(v).font(.caption).monospacedDigit()
        }
    }
}

func convLabel(_ a: Account) -> String {
    a.platform == "apple_ads" ? "installs" : a.platform == "google_lsa" ? "leads" : "conv"
}

func statusWord(_ a: Account) -> String {
    a.status == "no_api" ? "no API" : a.status == "not_configured" ? "not set up" : "read failed"
}

struct AccountDetail: View {
    let account: Account

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .firstTextBaseline) {
                    Text(account.accountRef).foregroundStyle(.secondary)
                    Text("·").foregroundStyle(.secondary)
                    Text(account.timeZone).foregroundStyle(.secondary)
                    Spacer()
                    Text("metrics read \(Fmt.ago(Fmt.iso(account.readAt.metrics)))").foregroundStyle(.secondary)
                }
                .font(.caption)
                ForEach(account.flags, id: \.self) { f in
                    Label(f.message, systemImage: f.isRed ? "exclamationmark.triangle.fill" : "exclamationmark.circle")
                        .foregroundStyle(f.isRed ? .red : .orange)
                }
                if account.unread {
                    Text(account.error ?? statusWord(account)).foregroundStyle(.secondary)
                } else {
                    Grid(alignment: .leading, horizontalSpacing: 26, verticalSpacing: 6) {
                        GridRow { Text(""); hdr("Spend"); hdr("Clicks"); hdr("Impr."); hdr(convLabel(account).capitalized); hdr("Cost/conv") }
                        row("Today", account.today)
                        row("Last 7 days", account.last7)
                    }
                    HStack(spacing: 26) {
                        kv("Daily budget", account.dailyBudget.map { Fmt.usd($0) } ?? "n/a")
                        kv("Expected by now", Fmt.usd(account.pace.expectedByNow))
                        kv("Pace", account.pace.ratio.map { String(format: "%.2fx", $0) } ?? "n/a")
                        kv("Day elapsed", Fmt.pct(account.pace.dayElapsed))
                        if account.lastLeadBasis != nil { kv("Last lead", Fmt.lead(account.lastLeadAt)) }
                    }
                    GroupBox("Spend per day, last 7 days") {
                        SpendSparkline(points: account.series, color: account.tint, showAxes: true, budget: account.dailyBudget)
                            .frame(height: 200).padding(.top, 6)
                    }
                    if !account.campaigns.isEmpty {
                        GroupBox("Campaigns") {
                            Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 7) {
                                GridRow { hdr("Campaign"); hdr("Status"); hdr("Budget"); hdr("Today"); hdr("Impr."); hdr("Clicks"); hdr("7d"); hdr("Disapproved") }
                                Divider().gridCellColumns(8)
                                ForEach(account.campaigns) { c in
                                    GridRow {
                                        Text(c.name).lineLimit(1).truncationMode(.middle).frame(maxWidth: 300, alignment: .leading)
                                        Text(c.servingStatus == "PENDING" ? "pending" : c.status.lowercased()).foregroundStyle(c.status == "ENABLED" || c.status == "RUNNING" ? .primary : .secondary)
                                        Text(c.dailyBudget.map { Fmt.usd($0) } ?? "n/a")
                                        Text(Fmt.usd(c.today.spend, cents: true))
                                        Text(Fmt.int(c.today.impressions))
                                        Text(Fmt.int(c.today.clicks))
                                        Text(Fmt.usd(c.last7.spend))
                                        Text(c.disapprovedAds.map(String.init) ?? "n/a").foregroundStyle((c.disapprovedAds ?? 0) > 0 ? .red : .secondary)
                                    }
                                    .font(.callout).monospacedDigit()
                                }
                            }
                            .padding(.top, 6)
                        }
                    }
                }
                if let n = account.note { Text(n).font(.caption).foregroundStyle(.secondary) }
                if let b = account.lastLeadBasis { Text("Last lead = \(b).").font(.caption).foregroundStyle(.secondary) }
            }
            .padding(20)
        }
        .navigationTitle(account.name)
    }

    private func hdr(_ s: String) -> some View { Text(s).font(.caption).foregroundStyle(.secondary) }

    @ViewBuilder private func row(_ label: String, _ m: Metric?) -> some View {
        GridRow {
            Text(label).foregroundStyle(.secondary)
            Text(Fmt.usd(m?.spend, cents: true)).font(.title3.weight(.semibold))
            Text(Fmt.int(m?.clicks))
            Text(Fmt.int(m?.impressions))
            Text(Fmt.conv(m?.conversions))
            Text(Fmt.usd(m?.costPerConversion))
        }
        .monospacedDigit()
    }

    private func kv(_ k: String, _ v: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(k).font(.caption).foregroundStyle(.secondary)
            Text(v).monospacedDigit()
        }
    }
}
