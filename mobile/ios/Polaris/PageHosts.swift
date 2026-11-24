import UIKit

/// The servers this phone keeps, managed from the page's Settings > This app > Hosts (`phoneHosts` in the dashboard's
/// `lib/mobile-bridge.ts`), the way the desktop app's are. Every answer has the shape the desktop app (and the Android
/// app's `PageHosts.java`) gives for the same call, so the page reads them all with one set of readers. Every address
/// is checked with the same probe as `ServerViewController`, and only hosts already on the list are switched to,
/// edited or removed.
@MainActor
enum PageHosts {
    /// Runs one call and hands its answer, as JSON, to `answer`. `reopen` opens the host chosen now, or the address
    /// screen when none is left; `presenter` shows the share sheet. An op this does not know answers null.
    static func call(
        op: String, args: [String: Any], presenter: UIViewController, reopen: @escaping () -> Void,
        answer: @escaping (String) -> Void
    ) {
        let text = { (key: String) in args[key] as? String ?? "" }
        Task { @MainActor in
            let out: Any?
            switch op {
            case "list": out = list()
            case "check": out = await check(text("address"))
            case "add": out = await add(text("address"), name: text("name"))
            case "switch": out = switchTo(text("origin"), reopen: reopen)
            case "edit": out = await edit(text("origin"), address: text("address"), name: text("name"), reopen: reopen)
            case "remove": out = await remove(text("origin"), reopen: reopen)
            case "status": out = await status(text("origin"))
            case "link": out = HostList.listLink(entries())
            case "copy": out = copy()
            case "export": out = export(from: presenter)
            case "import": out = importText(text("text"))
            default: out = nil
            }
            answer(json(out))
        }
    }

    private static func list() -> [String: Any] {
        let active = ServerStore.active?.id
        let servers: [[String: Any]] = ServerStore.all.map { host in
            var row: [String: Any] = [
                "origin": host.origin,
                "name": NSNull(),
                "host": URL(string: host.origin)?.host ?? host.origin,
                "active": host.id == active
            ]
            if let name = host.name, !name.isEmpty { row["name"] = name }
            return row
        }
        return ["servers": servers, "error": NSNull()]
    }

    private static func check(_ address: String) async -> [String: Any] {
        guard let origin = ServerAddress.origin(address) else {
            return ["ok": false, "message": String(localized: "server.invalid")]
        }
        let verdict = await ServerProbe.probe(origin)
        if verdict == .polaris { return ["ok": true, "message": NSNull()] }
        return ["ok": false, "message": reason(verdict)]
    }

    /// Keeps a new host after checking it; the one open stays open, as on the desktop.
    private static func add(_ address: String, name: String) async -> [String: Any] {
        guard let origin = ServerAddress.origin(address) else { return refused(String(localized: "server.invalid")) }
        if ServerStore.find(origin: origin) != nil { return refused(String(localized: "hosts.taken")) }
        if let problem = await probeProblem(origin) { return refused(problem) }
        // Checked again: the list may have changed while the address was asked.
        if ServerStore.find(origin: origin) != nil { return refused(String(localized: "hosts.taken")) }
        let before = ServerStore.active?.id
        let added = ServerStore.add(origin)
        if let before { ServerStore.select(before) }
        ServerStore.rename(added.id, to: name)
        return done
    }

    private static func switchTo(_ origin: String, reopen: @escaping () -> Void) -> [String: Any] {
        guard let host = ServerStore.find(origin: origin) else { return refused("") }
        if host.id == ServerStore.active?.id { return done }
        ServerStore.select(host.id)
        // After the answer reaches the page: the page goes with the window.
        DispatchQueue.main.async(execute: reopen)
        return done
    }

    /// Address and name together. A new address is checked to be a Polaris before it is kept.
    private static func edit(
        _ origin: String, address: String, name: String, reopen: @escaping () -> Void
    ) async -> [String: Any] {
        guard let host = ServerStore.find(origin: origin) else { return refused("") }
        guard let next = ServerAddress.origin(address) else { return refused(String(localized: "server.invalid")) }
        if next != host.origin {
            if ServerStore.find(origin: next) != nil { return refused(String(localized: "hosts.taken")) }
            if let problem = await probeProblem(next) { return refused(problem) }
            guard ServerStore.changeAddress(host.id, to: next) else { return refused(String(localized: "hosts.taken")) }
        }
        ServerStore.rename(host.id, to: name)
        // The window open now is on the old address: reopen it on the new one.
        if next != host.origin && host.id == ServerStore.active?.id { DispatchQueue.main.async(execute: reopen) }
        return done
    }

    /// Signs the phone out of a host and forgets it; removing the one open opens another, or asks for one.
    private static func remove(_ origin: String, reopen: @escaping () -> Void) async -> [String: Any] {
        guard let host = ServerStore.find(origin: origin) else { return refused("") }
        let current = host.id == ServerStore.active?.id
        await ServerStore.remove(host.id)
        if current { DispatchQueue.main.async(execute: reopen) }
        return done
    }

    /// "online" for a Polaris that answers (or is starting), "offline" for anything else. Listed hosts only.
    private static func status(_ origin: String) async -> String {
        guard ServerStore.find(origin: origin) != nil else { return "unknown" }
        let verdict = await ServerProbe.probe(origin)
        return verdict == .polaris || verdict == .starting ? "online" : "offline"
    }

    private static func copy() -> [String: Any] {
        let list = entries()
        guard !list.isEmpty else { return ["ok": false, "count": 0] }
        UIPasteboard.general.string = HostList.encode(list)
        return ["ok": true, "count": min(list.count, HostList.max)]
    }

    /// The code through the share sheet, where Files saves it as a file and Messages or Mail carries it. Whether
    /// somebody finished sharing is not known here, so the answer is the desktop's "cancelled" one, which the page
    /// says nothing about.
    private static func export(from presenter: UIViewController) -> [String: Any] {
        let list = entries()
        if !list.isEmpty {
            let share = UIActivityViewController(activityItems: [HostList.encode(list)], applicationActivities: nil)
            share.popoverPresentationController?.sourceView = presenter.view
            presenter.present(share, animated: true)
        }
        return ["ok": false, "error": NSNull()]
    }

    /// Takes in the hosts a pasted, scanned or opened code holds, the same way a scanned QR is.
    private static func importText(_ raw: String) -> [String: Any] {
        guard let hosts = HostList.read(raw) else { return ["ok": false, "error": String(localized: "link.hostsInvalid")] }
        let counts = ServerStore.importHosts(hosts)
        return ["ok": true, "added": counts.added, "named": counts.named, "skipped": counts.skipped]
    }

    private static func entries() -> [HostList.Entry] {
        ServerStore.all.map { HostList.Entry(origin: $0.origin, name: $0.name) }
    }

    /// Nil when a Polaris answers at the origin, else why not, in words.
    private static func probeProblem(_ origin: String) async -> String? {
        let verdict = await ServerProbe.probe(origin)
        return verdict == .polaris ? nil : reason(verdict)
    }

    static func reason(_ verdict: ServerProbe.Verdict) -> String {
        switch verdict {
        case .starting: return String(localized: "server.starting")
        case .redirects: return String(localized: "server.redirects")
        case .unreachable: return String(localized: "server.unreachable")
        default: return String(localized: "server.notPolaris")
        }
    }

    private static var done: [String: Any] { ["ok": true] }

    private static func refused(_ error: String) -> [String: Any] { ["ok": false, "error": error] }

    /// An answer as JSON: an object, a string, or null.
    private static func json(_ value: Any?) -> String {
        guard let value else { return "null" }
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
              let text = String(data: data, encoding: .utf8) else { return "null" }
        return text
    }
}
