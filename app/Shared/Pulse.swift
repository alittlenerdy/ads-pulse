import Foundation

/// Mirrors schema.json (server/src/core.ts PulseResponse). Every number the server
/// could not read arrives as null; we show "n/a", never 0.
struct Pulse: Codable {
    let generatedAt: String
    let cached: Bool
    let totals: Totals
    let accounts: [Account]
}

struct Totals: Codable {
    let todaySpend: Double
    let last7Spend: Double
    let accountsRead: Int
    let accountsTotal: Int
    let redFlags: Int
}

struct Metric: Codable {
    let spend: Double
    let clicks: Int
    let impressions: Int
    let conversions: Double?
    let costPerConversion: Double?
}

struct Flag: Codable, Hashable {
    let level: String
    let code: String
    let message: String
    var isRed: Bool { level == "red" }
}

struct Pace: Codable {
    let dayElapsed: Double
    let expectedByNow: Double?
    let ratio: Double?
}

struct Campaign: Codable, Identifiable {
    let id: String
    let name: String
    let status: String
    let servingStatus: String?
    let dailyBudget: Double?
    let today: Metric
    let last7: Metric
    let disapprovedAds: Int?
}

struct TrendPoint: Codable, Identifiable {
    let date: String
    let spend: Double
    let clicks: Int
    let impressions: Int
    let conversions: Double?
    var id: String { date }
    var day: Date {
        // Local midnight, so a chart's day label matches the account's calendar date.
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = .current
        return f.date(from: date) ?? Date()
    }
}

struct ReadAt: Codable {
    let metrics: String?
    let lastLead: String?
}

struct Account: Codable, Identifiable {
    let id: String
    let platform: String
    let name: String
    let accountRef: String
    let timeZone: String
    let currency: String
    let status: String
    let error: String?
    let todayDate: String
    let last7Start: String
    let today: Metric?
    let last7: Metric?
    let trend: [TrendPoint]?
    let dailyBudget: Double?
    let pace: Pace
    let lastLeadAt: String?
    let lastLeadBasis: String?
    let campaigns: [Campaign]
    let flags: [Flag]
    let readAt: ReadAt
    let note: String?

    var redFlags: [Flag] { flags.filter(\.isRed) }
    var hasRed: Bool { !redFlags.isEmpty }
    var hasAmber: Bool { flags.contains { $0.level == "amber" } }
    var series: [TrendPoint] { trend ?? [] }
    var unread: Bool { status == "no_api" || status == "not_configured" || status == "error" }
}

/// What the app writes to the App Group container for the widget.
struct Snapshot: Codable {
    let fetchedAt: Date
    let pulse: Pulse
}

enum Fmt {
    static func usd(_ v: Double?, cents: Bool = false) -> String {
        guard let v else { return "n/a" }
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        f.maximumFractionDigits = (cents || v < 100) ? 2 : 0
        f.minimumFractionDigits = (cents || v < 100) ? 2 : 0
        return f.string(from: NSNumber(value: v)) ?? "$\(v)"
    }

    static func usdShort(_ v: Double) -> String {
        v >= 1000 ? String(format: "$%.1fk", v / 1000) : String(format: "$%.0f", v.rounded())
    }

    static func int(_ v: Int?) -> String { v.map { NumberFormatter.localizedString(from: NSNumber(value: $0), number: .decimal) } ?? "n/a" }

    static func conv(_ v: Double?) -> String {
        guard let v else { return "n/a" }
        return v == v.rounded() ? String(Int(v)) : String(format: "%.1f", v)
    }

    static func pct(_ v: Double?) -> String { v.map { String(format: "%.0f%%", $0 * 100) } ?? "n/a" }

    static func iso(_ s: String?) -> Date? {
        guard let s else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }

    static func ago(_ d: Date?, now: Date = Date()) -> String {
        guard let d else { return "n/a" }
        let s = Int(now.timeIntervalSince(d))
        if s < 60 { return "just now" }
        if s < 3600 { return "\(s / 60)m ago" }
        if s < 86400 { return "\(s / 3600)h ago" }
        return "\(s / 86400)d ago"
    }

    /// lastLeadAt is either an ISO instant (LSA) or a bare date (conversion date).
    static func lead(_ s: String?) -> String {
        guard let s else { return "n/a" }
        if s.count == 10 {
            let inF = DateFormatter(); inF.dateFormat = "yyyy-MM-dd"; inF.timeZone = TimeZone(identifier: "UTC")
            let outF = DateFormatter(); outF.dateFormat = "MMM d"; outF.timeZone = TimeZone(identifier: "UTC")
            return inF.date(from: s).map { outF.string(from: $0) } ?? s
        }
        guard let d = iso(s) else { return s }
        let f = DateFormatter(); f.dateFormat = "MMM d, h:mm a"
        return f.string(from: d)
    }
}

enum Shared {
    static let keychainService = "ads-pulse"
    static let keychainAccount = "endpoint-token"

    /// Real home directory, even inside the widget's sandbox (NSHomeDirectory() is the container there).
    static var realHome: URL {
        if let pw = getpwuid(getuid()), let dir = pw.pointee.pw_dir { return URL(fileURLWithPath: String(cString: dir)) }
        return URL(fileURLWithPath: NSHomeDirectory())
    }

    /// The app writes here; the widget reads it through a read-only sandbox exception
    /// for this one folder (Widget/AdsPulseWidget.entitlements). No App Group needed,
    /// so the app builds and runs ad-hoc signed without an Apple developer team.
    static var snapshotURL: URL {
        realHome.appendingPathComponent("Library/Application Support/AdsPulse/pulse.json")
    }

    static func save(_ s: Snapshot) {
        let url = snapshotURL
        let enc = JSONEncoder(); enc.dateEncodingStrategy = .iso8601
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? enc.encode(s).write(to: url, options: .atomic)
    }

    static func load() -> Snapshot? {
        guard let data = try? Data(contentsOf: snapshotURL) else { return nil }
        let dec = JSONDecoder(); dec.dateDecodingStrategy = .iso8601
        return try? dec.decode(Snapshot.self, from: data)
    }
}

/// Endpoint settings. The URL lives in UserDefaults; the token only in the Keychain.
enum AppConfig {
    private static let d = UserDefaults.standard
    static var endpoint: URL? {
        get { d.string(forKey: "endpoint").flatMap(URL.init(string:)) }
        set { d.set(newValue?.absoluteString, forKey: "endpoint") }
    }
    /// Demo mode is on until an endpoint is saved, so first launch shows something.
    static var demo: Bool {
        get { d.object(forKey: "demo") as? Bool ?? (endpoint == nil) }
        set { d.set(newValue, forKey: "demo") }
    }
}

extension Pulse {
    /// All accounts' spend per day.
    var combinedTrend: [TrendPoint] {
        var by: [String: Double] = [:]
        for a in accounts { for p in a.series { by[p.date, default: 0] += p.spend } }
        return by.keys.sorted().map { TrendPoint(date: $0, spend: by[$0]!, clicks: 0, impressions: 0, conversions: nil) }
    }
}
