import SwiftUI
import Charts

/// 7-day spend line, used by the window and the widgets.
struct SpendSparkline: View {
    let points: [TrendPoint]
    var color: Color = .accentColor
    var showAxes = false
    var budget: Double? = nil

    var body: some View {
        Chart {
            ForEach(points) { p in
                AreaMark(x: .value("Day", p.day, unit: .day), y: .value("Spend", p.spend))
                    .foregroundStyle(LinearGradient(colors: [color.opacity(0.28), color.opacity(0.02)], startPoint: .top, endPoint: .bottom))
                    .interpolationMethod(.monotone)
                LineMark(x: .value("Day", p.day, unit: .day), y: .value("Spend", p.spend))
                    .foregroundStyle(color)
                    .lineStyle(StrokeStyle(lineWidth: showAxes ? 2.2 : 1.6, lineCap: .round))
                    .interpolationMethod(.monotone)
                if showAxes {
                    PointMark(x: .value("Day", p.day, unit: .day), y: .value("Spend", p.spend))
                        .foregroundStyle(color).symbolSize(22)
                }
            }
            if let b = budget, b > 0, showAxes {
                RuleMark(y: .value("Budget", b))
                    .foregroundStyle(.secondary.opacity(0.6))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 3]))
                    .annotation(position: .top, alignment: .trailing) { Text("budget \(Fmt.usd(b))/d").font(.caption2).foregroundStyle(.secondary) }
            }
        }
        .chartXAxis(showAxes ? .automatic : .hidden)
        .chartYAxis(showAxes ? .automatic : .hidden)
        .chartXAxis {
            if showAxes { AxisMarks(values: .stride(by: .day)) { _ in AxisValueLabel(format: .dateTime.weekday(.abbreviated), centered: true); AxisGridLine() } }
        }
        .chartYAxis {
            if showAxes { AxisMarks { v in AxisGridLine(); AxisValueLabel { if let d = v.as(Double.self) { Text(Fmt.usdShort(d)) } } } }
        }
    }
}

extension Account {
    var tint: Color {
        switch platform {
        case "google_lsa": return .teal
        case "apple_ads": return .pink
        case "chatgpt_ads": return .purple
        default: return .blue
        }
    }
}
