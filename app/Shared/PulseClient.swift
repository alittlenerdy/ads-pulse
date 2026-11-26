import Foundation
import Security

enum PulseError: LocalizedError {
    case noEndpoint, noToken, http(Int), decode(String)
    var errorDescription: String? {
        switch self {
        case .noEndpoint: return "No endpoint set. Add one in Settings, or turn on demo mode."
        case .noToken: return "No token in the Keychain. Paste it in Settings."
        case .http(let c): return c == 401 ? "Token rejected (401)." : "Server returned HTTP \(c)."
        case .decode(let m): return "Could not read the response: \(m)"
        }
    }
}

/// The endpoint token, stored as a generic password in the login Keychain.
enum Keychain {
    private static var base: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: Shared.keychainService,
         kSecAttrAccount as String: Shared.keychainAccount]
    }

    static func token() -> String? {
        var q = base
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        let s = String(data: d, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (s?.isEmpty ?? true) ? nil : s
    }

    @discardableResult
    static func setToken(_ value: String) -> Bool {
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = Data(value.trimmingCharacters(in: .whitespacesAndNewlines).utf8)
        add[kSecAttrLabel as String] = "Ads Pulse endpoint token"
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    static func clear() { SecItemDelete(base as CFDictionary) }
}

enum PulseClient {
    static func fetch(fresh: Bool = false) async throws -> Pulse {
        if AppConfig.demo { return DemoData.pulse() }
        guard let endpoint = AppConfig.endpoint else { throw PulseError.noEndpoint }
        guard let token = Keychain.token() else { throw PulseError.noToken }
        var comps = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)!
        if fresh { comps.queryItems = (comps.queryItems ?? []) + [URLQueryItem(name: "fresh", value: "1")] }
        var req = URLRequest(url: comps.url!, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 70)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else { throw PulseError.http(code) }
        do { return try JSONDecoder().decode(Pulse.self, from: data) } catch { throw PulseError.decode(String(describing: error).prefix(200).description) }
    }
}
