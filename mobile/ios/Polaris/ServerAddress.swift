import Foundation

/// What somebody types as their Polaris's address, made into the one origin the app keeps - the same rules as the
/// Android app's ServerAddress: "polaris.example.com" and "HTTPS://Polaris.Example.com/home" are both
/// "https://polaris.example.com".
enum ServerAddress {
    static let maxLength = 300

    static func origin(_ typed: String?) -> String? {
        guard var text = typed?.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty, text.count <= maxLength else { return nil }
        if !text.contains("://") { text = "https://" + text }
        guard let parts = URLComponents(string: text),
              let scheme = parts.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil else { return nil }
        let port = parts.port
        let usual = port == nil || (scheme == "https" && port == 443) || (scheme == "http" && port == 80)
        return "\(scheme)://\(host)\(usual ? "" : ":\(port!)")"
    }

    /// Whether a link belongs to this Polaris, so it stays in the app instead of opening in Safari.
    static func sameOrigin(_ origin: String?, _ url: URL?) -> Bool {
        guard let origin, let url, url.absoluteString.contains("://") else { return false }
        return Self.origin(url.absoluteString) == origin
    }
}
