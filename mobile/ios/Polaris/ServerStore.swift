import Foundation
import WebKit

/// One Polaris this phone opens.
struct Host: Codable, Equatable {
    /// "default" for the Polaris kept before there was a list, whose session lives in the shared web data; a UUID for
    /// every other, which on iOS 17 and later is also the name of its own web data store.
    let id: String
    let origin: String
    var name: String?

    /// What the list shows: the name somebody gave it, or its address without the scheme.
    var label: String {
        if let name, !name.isEmpty { return name }
        return URL(string: origin)?.host ?? origin
    }
}

/// Every Polaris this phone opens, and the one it opens now, kept between launches.
///
/// On iOS 17 and later each one has its own web data store - its own cookies and storage - so being signed in to one
/// never signs anybody in or out of another. Before iOS 17 every host shares the default store, where cookies are
/// still kept per site, so each is signed in on its own there too.
enum ServerStore {
    private static let hostsKey = "server.hosts"
    private static let activeKey = "server.active"
    /// Where the one Polaris was kept before there was a list.
    private static let legacyKey = "server.origin"
    static let defaultId = "default"

    static var all: [Host] {
        migrate()
        guard let data = UserDefaults.standard.data(forKey: hostsKey),
              let hosts = try? JSONDecoder().decode([Host].self, from: data) else { return [] }
        return hosts
    }

    private static func save(_ hosts: [Host]) {
        if let data = try? JSONEncoder().encode(hosts) { UserDefaults.standard.set(data, forKey: hostsKey) }
    }

    /// The Polaris the app opens on, or nil when there is none.
    static var active: Host? {
        let hosts = all
        let id = UserDefaults.standard.string(forKey: activeKey)
        return hosts.first(where: { $0.id == id }) ?? hosts.first
    }

    static func select(_ id: String) {
        UserDefaults.standard.set(id, forKey: activeKey)
    }

    static func find(origin: String) -> Host? {
        all.first(where: { $0.origin == origin })
    }

    /// Add a Polaris (or find it, when it is already on the list) and make it the one the app opens.
    @discardableResult
    static func add(_ origin: String, name: String? = nil) -> Host {
        if let known = find(origin: origin) {
            select(known.id)
            return known
        }
        var hosts = all
        // The first one goes in the shared store, where a session from before the list already lives.
        let host = Host(id: hosts.isEmpty ? defaultId : UUID().uuidString, origin: origin, name: name)
        hosts.append(host)
        save(hosts)
        select(host.id)
        return host
    }

    /// Hosts from another device, as `HostList` read them: (added, named, skipped). One already here keeps its own
    /// name unless it had none; nothing is selected, so the Polaris open now stays open.
    @discardableResult
    static func importHosts(_ entries: [HostList.Entry]) -> (added: Int, named: Int, skipped: Int) {
        var hosts = all
        var added = 0, named = 0, skipped = 0
        for entry in entries {
            if let index = hosts.firstIndex(where: { $0.origin == entry.origin }) {
                if hosts[index].name == nil, let name = entry.name {
                    hosts[index].name = name
                    named += 1
                } else {
                    skipped += 1
                }
                continue
            }
            hosts.append(Host(id: hosts.isEmpty ? defaultId : UUID().uuidString, origin: entry.origin, name: entry.name))
            added += 1
        }
        save(hosts)
        if UserDefaults.standard.string(forKey: activeKey) == nil, let first = hosts.first { select(first.id) }
        return (added, named, skipped)
    }

    static func rename(_ id: String, to name: String?) {
        var hosts = all
        guard let index = hosts.firstIndex(where: { $0.id == id }) else { return }
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        hosts[index].name = (trimmed?.isEmpty ?? true) ? nil : String(trimmed!.prefix(HostList.nameMax))
        save(hosts)
    }

    /// Take a Polaris off the list and forget what this phone kept for it: its own store where it has one, its
    /// cookies and site data in the shared one where it does not.
    @MainActor
    static func remove(_ id: String) async {
        let hosts = all
        guard let host = hosts.first(where: { $0.id == id }) else { return }
        save(hosts.filter { $0.id != id })
        if UserDefaults.standard.string(forKey: activeKey) == id {
            UserDefaults.standard.removeObject(forKey: activeKey)
        }
        if #available(iOS 17.0, *), let uuid = UUID(uuidString: id) {
            try? await WKWebsiteDataStore.remove(forIdentifier: uuid)
            return
        }
        guard let domain = URL(string: host.origin)?.host else { return }
        let store = WKWebsiteDataStore.default()
        let types = WKWebsiteDataStore.allWebsiteDataTypes()
        let records = await store.dataRecords(ofTypes: types)
        let mine = records.filter { $0.displayName == domain || domain.hasSuffix("." + $0.displayName) }
        await store.removeData(ofTypes: types, for: mine)
    }

    /// The web data a host's pages are kept in.
    @MainActor
    static func dataStore(for host: Host) -> WKWebsiteDataStore {
        if #available(iOS 17.0, *), let uuid = UUID(uuidString: host.id) {
            return WKWebsiteDataStore(forIdentifier: uuid)
        }
        return .default()
    }

    /// The single Polaris of an older version of the app becomes the host "default".
    private static func migrate() {
        let defaults = UserDefaults.standard
        guard defaults.data(forKey: hostsKey) == nil, let origin = defaults.string(forKey: legacyKey) else { return }
        save([Host(id: defaultId, origin: origin, name: nil)])
        defaults.set(defaultId, forKey: activeKey)
        defaults.removeObject(forKey: legacyKey)
    }
}
