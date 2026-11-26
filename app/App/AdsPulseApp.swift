import SwiftUI
import WidgetKit
import AppKit
import ServiceManagement

@MainActor
final class PulseModel: ObservableObject {
    @Published var pulse: Pulse?
    @Published var fetchedAt: Date?
    @Published var error: String?
    @Published var loading = false
    private var timer: Timer?

    init() {
        if UserDefaults.standard.bool(forKey: "launchAtLogin"), SMAppService.mainApp.status != .enabled { try? SMAppService.mainApp.register() }
        if let s = Shared.load() { pulse = s.pulse; fetchedAt = s.fetchedAt }
        Task { await refresh() }
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.refresh() }
        }
    }

    func refresh(fresh: Bool = false) async {
        loading = true
        defer { loading = false }
        do {
            let p = try await PulseClient.fetch(fresh: fresh)
            let changed = p.generatedAt != pulse?.generatedAt
            pulse = p
            fetchedAt = Date()
            error = nil
            Shared.save(Snapshot(fetchedAt: fetchedAt!, pulse: p))
            if changed { WidgetCenter.shared.reloadAllTimelines() }
        } catch {
            self.error = error.localizedDescription
        }
    }

    var menuTitle: String {
        guard let p = pulse else { return error == nil ? "Ads …" : "Ads ⚠︎" }
        return Fmt.usdShort(p.totals.todaySpend)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

@main
struct AdsPulseApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var model = PulseModel()

    var body: some Scene {
        // First scene: opens at launch and when the Dock icon is clicked.
        Window("Ads Pulse", id: "main") {
            MainWindow(model: model)
                .frame(minWidth: 820, minHeight: 560)
        }
        .defaultSize(width: 1040, height: 760)

        Window("Widget preview", id: "preview") {
            WidgetPreview(model: model)
        }
        .windowResizability(.contentSize)

        MenuBarExtra {
            PulsePanel(model: model, compact: true)
                .frame(width: 380)
        } label: {
            HStack(spacing: 3) {
                if (model.pulse?.totals.redFlags ?? 0) > 0 {
                    Image(systemName: "exclamationmark.triangle.fill")
                } else {
                    Image(systemName: "chart.line.uptrend.xyaxis")
                }
                Text(model.menuTitle).monospacedDigit()
            }
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView(model: model)
        }
    }
}

/// The widget's own views at their real sizes, for checking without adding it to the desktop.
struct WidgetPreview: View {
    @ObservedObject var model: PulseModel
    var body: some View {
        let entry = PulseEntry(date: Date(), snapshot: model.pulse.map { Snapshot(fetchedAt: model.fetchedAt ?? Date(), pulse: $0) }, error: model.error)
        HStack(alignment: .top, spacing: 20) {
            PulseWidgetView(entry: entry, familyOverride: .systemSmall)
                .padding(14).frame(width: 170, height: 170)
                .background(RoundedRectangle(cornerRadius: 22).fill(.background.secondary))
            PulseWidgetView(entry: entry, familyOverride: .systemMedium)
                .padding(14).frame(width: 364, height: 170)
                .background(RoundedRectangle(cornerRadius: 22).fill(.background.secondary))
            PulseWidgetView(entry: entry, familyOverride: .systemLarge)
                .padding(14).frame(width: 364, height: 382)
                .background(RoundedRectangle(cornerRadius: 22).fill(.background.secondary))
        }
        .padding(24)
    }
}
