import SwiftUI
import AppKit
import ServiceManagement

struct PulsePanel: View {
    @ObservedObject var model: PulseModel
    let compact: Bool
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            if let p = model.pulse {
                // No ScrollView here: inside a MenuBarExtra window it has no intrinsic
                // height and collapses to zero.
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(p.accounts) { AccountRow(account: $0, expanded: !compact) }
                }
                .padding(12)
                .fixedSize(horizontal: false, vertical: true)
            } else {
                Text(model.error ?? "Loading…").foregroundStyle(.secondary).padding(16)
            }
            Divider()
            footer
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Today").font(.caption).foregroundStyle(.secondary)
                Text(Fmt.usd(model.pulse?.totals.todaySpend, cents: true)).font(.system(size: 26, weight: .semibold)).monospacedDigit()
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text("Last 7 days").font(.caption).foregroundStyle(.secondary)
                Text(Fmt.usd(model.pulse?.totals.last7Spend)).font(.title3).monospacedDigit()
            }
        }
        .padding(12)
    }

    private var footer: some View {
        HStack(spacing: 10) {
            if let e = model.error {
                Label(e, systemImage: "exclamationmark.circle").foregroundStyle(.red).lineLimit(1)
            } else if AppConfig.demo {
                Text("Demo mode · fake data").foregroundStyle(.secondary)
            } else if let p = model.pulse {
                Text("Server read \(Fmt.ago(Fmt.iso(p.generatedAt)))\(p.cached ? " (cached)" : "")").foregroundStyle(.secondary)
            }
            Spacer()
            if model.loading { ProgressView().controlSize(.small) }
            Button { Task { await model.refresh(fresh: true) } } label: { Image(systemName: "arrow.clockwise") }
                .help("Read every account now (skips the 5-minute cache)")
            if compact {
                Button { openWindow(id: "main"); NSApp.activate(ignoringOtherApps: true) } label: { Image(systemName: "macwindow") }
                    .help("Open window")
                SettingsLink { Image(systemName: "gearshape") }
                Button { NSApp.terminate(nil) } label: { Image(systemName: "power") }.help("Quit")
            }
        }
        .buttonStyle(.borderless)
        .font(.caption)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

struct AccountRow: View {
    let account: Account
    let expanded: Bool
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Circle().fill(dot).frame(width: 8, height: 8)
                Text(account.name).font(.headline)
                Spacer()
                if account.unread {
                    Text(account.status == "no_api" ? "no API" : account.status == "not_configured" ? "not set up" : "read failed").foregroundStyle(.secondary)
                } else {
                    SpendSparkline(points: account.series, color: account.tint).frame(width: 70, height: 20)
                    Text(Fmt.usd(account.today?.spend, cents: true)).font(.headline).monospacedDigit()
                }
            }
            if !account.unread {
                HStack(spacing: 12) {
                    stat("7d", Fmt.usd(account.last7?.spend))
                    stat("clicks", Fmt.int(account.today?.clicks))
                    stat("impr", Fmt.int(account.today?.impressions))
                    stat(account.platform == "apple_ads" ? "installs" : account.platform == "google_lsa" ? "leads" : "conv", Fmt.conv(account.today?.conversions))
                    stat("CPA 7d", Fmt.usd(account.last7?.costPerConversion))
                }
                HStack(spacing: 12) {
                    stat("budget", account.dailyBudget.map { Fmt.usd($0) + "/d" } ?? "n/a")
                    stat("pace", account.pace.ratio.map { String(format: "%.2fx", $0) } ?? "n/a")
                    if account.lastLeadBasis != nil { stat("last lead", Fmt.lead(account.lastLeadAt)) }
                    stat("read", Fmt.ago(Fmt.iso(account.readAt.metrics)))
                }
            }
            ForEach(account.flags, id: \.self) { f in
                Label(f.message, systemImage: f.isRed ? "exclamationmark.triangle.fill" : "exclamationmark.circle")
                    .font(.caption).foregroundStyle(f.isRed ? .red : .orange)
            }
            if let e = account.error, account.flags.isEmpty { Text(e).font(.caption).foregroundStyle(.secondary) }
            if (expanded || open), !account.campaigns.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(account.campaigns) { c in
                        HStack {
                            Text(c.name).lineLimit(1).truncationMode(.middle)
                            Text(c.servingStatus == "PENDING" ? "pending" : c.status.lowercased()).foregroundStyle(.secondary)
                            Spacer()
                            Text("\(Fmt.usd(c.today.spend, cents: true)) · \(Fmt.int(c.today.impressions)) impr").monospacedDigit()
                        }
                        .font(.caption)
                    }
                }
                .padding(.leading, 16)
            }
            if let n = account.note, expanded || open { Text(n).font(.caption2).foregroundStyle(.secondary) }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.05)))
        .contentShape(Rectangle())
        .onTapGesture { if !expanded { withAnimation { open.toggle() } } }
    }

    private var dot: Color {
        if account.hasRed { return .red }
        if account.hasAmber { return .orange }
        if account.unread { return .gray }
        return .green
    }

    private func stat(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Text(value).font(.caption).monospacedDigit()
        }
    }
}

struct SettingsView: View {
    @ObservedObject var model: PulseModel
    @State private var endpoint = AppConfig.endpoint?.absoluteString ?? ""
    @State private var token = ""
    @State private var demo = AppConfig.demo
    @AppStorage("launchAtLogin") private var launchAtLogin = false
    @State private var saved: String?

    var body: some View {
        Form {
            Toggle("Demo mode (fake data, no endpoint needed)", isOn: $demo)
                .onChange(of: demo) { _, v in AppConfig.demo = v; Task { await model.refresh(fresh: true) } }
            Toggle("Open at login", isOn: $launchAtLogin)
                .onChange(of: launchAtLogin) { _, v in
                    if v { try? SMAppService.mainApp.register() } else { try? SMAppService.mainApp.unregister() }
                }
            Divider()
            TextField("Endpoint URL", text: $endpoint, prompt: Text("https://your-server.example.com/api/ads-pulse"))
            SecureField("Bearer token", text: $token, prompt: Text(Keychain.token() == nil ? "not set" : "stored in Keychain (leave blank to keep)"))
            HStack {
                Button("Save") { save() }.keyboardShortcut(.defaultAction)
                if let s = saved { Text(s).foregroundStyle(.secondary) }
            }
            Text("The endpoint must return the JSON in schema.json. HTTPS required (http://localhost is allowed for testing). The token is stored in your login Keychain, never in a file.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .padding(20)
        .frame(width: 480)
    }

    private func save() {
        let trimmed = endpoint.trimmingCharacters(in: .whitespaces)
        guard let url = URL(string: trimmed), let scheme = url.scheme, scheme == "https" || (scheme == "http" && ["localhost", "127.0.0.1"].contains(url.host ?? "")) else {
            saved = "Enter an https:// URL."
            return
        }
        AppConfig.endpoint = url
        if !token.isEmpty { saved = Keychain.setToken(token) ? "Saved." : "Keychain write failed." } else { saved = "Saved." }
        token = ""
        demo = false
        AppConfig.demo = false
        Task { await model.refresh(fresh: true) }
    }
}
