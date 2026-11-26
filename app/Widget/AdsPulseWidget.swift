import WidgetKit
import SwiftUI

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> PulseEntry { PulseEntry(date: Date(), snapshot: Shared.load(), error: nil) }

    func getSnapshot(in context: Context, completion: @escaping (PulseEntry) -> Void) {
        completion(PulseEntry(date: Date(), snapshot: Shared.load(), error: nil))
    }

    /// The app writes a fresh snapshot every 60 seconds and reloads us; we only read it.
    func getTimeline(in context: Context, completion: @escaping (Timeline<PulseEntry>) -> Void) {
        let entry = PulseEntry(date: Date(), snapshot: Shared.load(), error: nil)
        completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(5 * 60))))
    }
}

@main
struct AdsPulseWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "AdsPulseWidget", provider: Provider()) { entry in
            PulseWidgetView(entry: entry).containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Ads Pulse")
        .description("Today's spend and red flags across every ad account.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
