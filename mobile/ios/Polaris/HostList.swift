import Foundation

/// A list of Polaris hosts carried from another device: the code the desktop app copies, the `polaris://hosts` link
/// its QR holds (which the iPhone's camera opens this app on), or the file it exports. The same three shapes, read the
/// same way, as `host-list` in the dashboard's core package and the Android app's HostList.
///
/// Only addresses and names cross, never a session: every host taken in still asks to sign in. Whatever is read is
/// untrusted - every address must be a bare http(s) origin, names are trimmed and capped, and so is the list.
enum HostList {
    static let prefix = "polaris-hosts:1:"
    static let link = "polaris://hosts"
    /// The most hosts one list carries, the same cap the desktop app writes with.
    static let max = 50
    static let nameMax = 40
    private static let inputMax = 64 * 1024
    private static let fileKind = "polaris-hosts"

    /// One host as it travels. `name` is nil when nobody named it.
    struct Entry: Equatable {
        let origin: String
        let name: String?
    }

    /// The hosts in a code, a link or a file, or nil when the text is none of them. An empty list is a list.
    static func read(_ raw: String?) -> [Entry]? {
        guard let raw, raw.utf8.count <= inputMax else { return nil }
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix(prefix) { return fromCode(text) }
        if text.lowercased().hasPrefix(link + "?") {
            guard let parts = URLComponents(string: text),
                  let list = parts.queryItems?.first(where: { $0.name == "list" })?.value,
                  list.hasPrefix(prefix) else { return nil }
            return fromCode(list)
        }
        if text.hasPrefix("{") { return fromFile(text) }
        return nil
    }

    private static func fromCode(_ code: String) -> [Entry]? {
        guard let json = fromBase64Url(String(code.dropFirst(prefix.count))),
              let rows = try? JSONSerialization.jsonObject(with: json) as? [Any] else { return nil }
        return settle(rows.compactMap { row -> (String?, String?)? in
            guard let row = row as? [Any] else { return nil }
            return (row.first as? String, row.count > 1 ? row[1] as? String : nil)
        })
    }

    private static func fromFile(_ text: String) -> [Entry]? {
        guard let data = text.data(using: .utf8),
              let file = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              file["kind"] as? String == fileKind,
              let hosts = file["hosts"] as? [Any] else { return nil }
        return settle(hosts.compactMap { row -> (String?, String?)? in
            guard let row = row as? [String: Any] else { return nil }
            return (row["origin"] as? String, row["name"] as? String)
        })
    }

    /// The rows as read, with duplicates and unusable rows dropped, capped.
    private static func settle(_ rows: [(String?, String?)]) -> [Entry] {
        var hosts: [Entry] = []
        for (address, name) in rows {
            if hosts.count == max { break }
            guard let origin = originOf(address), !hosts.contains(where: { $0.origin == origin }) else { continue }
            hosts.append(Entry(origin: origin, name: nameOf(name)))
        }
        return hosts
    }

    /// The list as the code the desktop app copies, read back by `read`: rows of `[address]` or `[address, name]`,
    /// https left out of each address to keep it short, base64url without padding. Capped at `max`.
    static func encode(_ entries: [Entry]) -> String {
        var rows: [[String]] = []
        for entry in entries {
            if rows.count == max { break }
            guard let origin = originOf(entry.origin) else { continue }
            let short = origin.hasPrefix("https://") ? String(origin.dropFirst("https://".count)) : origin
            if let name = nameOf(entry.name) { rows.append([short, name]) } else { rows.append([short]) }
        }
        let json = (try? JSONSerialization.data(withJSONObject: rows, options: [.withoutEscapingSlashes])) ?? Data("[]".utf8)
        let base64 = json.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return prefix + base64
    }

    /// A bare http(s) origin, or nil. A bare host in the compact form is https, the only scheme left out of it.
    static func originOf(_ value: String?) -> String? {
        guard let value, value.count <= 2048 else { return nil }
        let typed = value.range(of: "^[A-Za-z][A-Za-z0-9+.-]*://", options: .regularExpression) != nil
            ? value : "https://" + value
        guard let parts = URLComponents(string: typed) else { return nil }
        if !parts.percentEncodedPath.isEmpty && parts.percentEncodedPath != "/" { return nil }
        if parts.percentEncodedQuery != nil || parts.percentEncodedFragment != nil { return nil }
        return ServerAddress.origin(typed)
    }

    private static func nameOf(_ value: String?) -> String? {
        guard let value else { return nil }
        var name = value.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        if name.count > nameMax { name = String(name.prefix(nameMax)).trimmingCharacters(in: .whitespaces) }
        return name.isEmpty ? nil : name
    }

    private static func fromBase64Url(_ code: String) -> Data? {
        guard code.range(of: "^[A-Za-z0-9_-]*$", options: .regularExpression) != nil else { return nil }
        var base64 = code.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 { base64 += "=" }
        guard let data = Data(base64Encoded: base64), String(data: data, encoding: .utf8) != nil else { return nil }
        return data
    }
}

/// `polaris://open?server=<origin>&path=<path>`: a page of a Polaris, opened in this app by a link somebody followed -
/// read the same way as the desktop app's and the Android app's.
///
/// Any website can start such a link, so it only ever names a page to show. A Polaris that is not on this phone is
/// never opened from one without a yes.
struct DeepLink: Equatable {
    let server: String
    let path: String

    /// What a link asks for, or nil when it is not one of ours.
    static func read(_ value: String?) -> DeepLink? {
        guard let value, value.count <= 2048, let parts = URLComponents(string: value),
              parts.scheme?.lowercased() == "polaris", parts.host?.lowercased() == "open" else { return nil }
        let items = parts.queryItems ?? []
        guard let server = HostList.originOf(items.first(where: { $0.name == "server" })?.value) else { return nil }
        let path = items.first(where: { $0.name == "path" })?.value ?? "/"
        if !path.hasPrefix("/") || path.hasPrefix("//") || path.contains("\\") { return nil }
        return DeepLink(server: server, path: path)
    }

    /// The page's full address.
    var url: URL? { URL(string: server + path) }
}
