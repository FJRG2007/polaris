import UIKit

/// The app's own screen: every Polaris this phone opens - tap one to open it, or add another - then notifications and
/// language, the browser, and the version. Editing, removing, reordering, importing and exporting hosts is the page's
/// Settings > This app > Hosts (`PageHosts`), as on the desktop app. Each Polaris is signed in on its own, so switching
/// never signs anybody out. Reached from the page that shows when a Polaris cannot be reached.
final class HostsViewController: UITableViewController {
    private enum Section: Int, CaseIterable { case hosts, transfer, app, about }
    private enum AppRow: Int, CaseIterable { case system, browser }

    private let open: () -> Void
    private let add: () -> Void
    private var hosts: [Host] = []

    init(open: @escaping () -> Void, add: @escaping () -> Void) {
        self.open = open
        self.add = add
        super.init(style: .insetGrouped)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = String(localized: "settings.title")
        view.backgroundColor = Palette.background
        tableView.backgroundColor = Palette.background
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "row")
        if ServerStore.active != nil {
            navigationItem.leftBarButtonItem = UIBarButtonItem(
                title: String(localized: "settings.done"), primaryAction: UIAction { [weak self] _ in self?.open() }
            )
        }
        let appearance = UINavigationBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = Palette.background
        appearance.titleTextAttributes = [.foregroundColor: Palette.foreground]
        navigationController?.navigationBar.standardAppearance = appearance
        navigationController?.navigationBar.scrollEdgeAppearance = appearance
        navigationController?.navigationBar.tintColor = Palette.primary
        reload()
    }

    private func reload() {
        hosts = ServerStore.all
        tableView.reloadData()
    }

    // MARK: Table

    override func numberOfSections(in tableView: UITableView) -> Int { Section.allCases.count }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        switch Section(rawValue: section) {
        case .hosts: return hosts.count
        case .transfer: return 1
        case .app: return ServerStore.active == nil ? 1 : AppRow.allCases.count
        case .about: return 1
        case nil: return 0
        }
    }

    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        switch Section(rawValue: section) {
        case .hosts: return String(localized: "hosts.title")
        case .app: return String(localized: "settings.app")
        case .about: return String(localized: "settings.about")
        default: return nil
        }
    }

    override func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? {
        switch Section(rawValue: section) {
        case .transfer: return String(localized: "hosts.scanHint")
        default: return nil
        }
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "row", for: indexPath)
        cell.backgroundColor = Palette.field
        cell.tintColor = Palette.primary
        cell.accessoryType = .none
        cell.selectionStyle = .default
        switch Section(rawValue: indexPath.section) {
        case .hosts:
            let host = hosts[indexPath.row]
            cell.contentConfiguration = content(host.label, host.origin)
            cell.accessoryType = host.id == ServerStore.active?.id ? .checkmark : .none
            cell.accessibilityHint = String(format: String(localized: "hosts.open"), host.label)
        case .transfer:
            cell.contentConfiguration = content(String(localized: "hosts.add"), nil, tinted: true)
        case .app:
            switch AppRow(rawValue: indexPath.row) {
            case .system:
                cell.contentConfiguration = content(
                    String(localized: "settings.system"), String(localized: "settings.systemHint")
                )
                cell.accessoryType = .disclosureIndicator
            case .browser, nil:
                cell.contentConfiguration = content(String(localized: "settings.browser"), ServerStore.active?.origin)
            }
        case .about, nil:
            let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
            cell.contentConfiguration = content(String(format: String(localized: "settings.version"), version), nil)
            cell.selectionStyle = .none
        }
        return cell
    }

    private func content(_ text: String, _ detail: String?, tinted: Bool = false) -> UIListContentConfiguration {
        var content = UIListContentConfiguration.subtitleCell()
        content.text = text
        content.secondaryText = detail
        content.textProperties.color = tinted ? Palette.primary : Palette.foreground
        content.textProperties.font = Plex.font(.medium, 16, .body)
        content.secondaryTextProperties.color = Palette.muted
        content.secondaryTextProperties.font = Plex.font(.regular, 13, .footnote)
        content.textProperties.numberOfLines = 1
        content.secondaryTextProperties.numberOfLines = 0
        return content
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        switch Section(rawValue: indexPath.section) {
        case .hosts:
            ServerStore.select(hosts[indexPath.row].id)
            open()
        case .transfer:
            add()
        case .app:
            switch AppRow(rawValue: indexPath.row) {
            case .system:
                // Notifications, language and the camera and microphone for this app all live on its page in the
                // Settings app; iOS offers no way in to just one of them.
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            case .browser, nil:
                if let origin = ServerStore.active?.origin, let url = URL(string: origin) { UIApplication.shared.open(url) }
            }
        default:
            break
        }
    }
}
