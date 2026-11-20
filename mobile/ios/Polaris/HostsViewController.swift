import UIKit
import UniformTypeIdentifiers

/// The app's own settings, what the desktop app keeps in its Settings window: every Polaris this phone opens - tap one
/// to open it, swipe to edit or remove it, Edit to reorder, add another, import the servers from another device or
/// export them to one - then notifications and language, the browser, and the version. Each Polaris is signed in on
/// its own, so switching never signs anybody out. Reached from Settings in the account menu of any Polaris page and
/// from the page that shows when a Polaris cannot be reached.
final class HostsViewController: UITableViewController, UIDocumentPickerDelegate {
    private enum Section: Int, CaseIterable { case hosts, transfer, app, about }
    private enum Transfer: Int, CaseIterable { case add, importHosts, exportHosts }
    private enum AppRow: Int, CaseIterable { case system, browser }

    private static let maxFileBytes = 64 * 1024
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
        navigationItem.rightBarButtonItem = editButtonItem
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
        case .transfer: return Transfer.allCases.count
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
            switch Transfer(rawValue: indexPath.row) {
            case .add: cell.contentConfiguration = content(String(localized: "hosts.add"), nil, tinted: true)
            case .importHosts: cell.contentConfiguration = content(String(localized: "hosts.import"), nil, tinted: true)
            case .exportHosts, nil: cell.contentConfiguration = content(String(localized: "hosts.export"), nil, tinted: true)
            }
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
            switch Transfer(rawValue: indexPath.row) {
            case .add: add()
            case .importHosts: askImport()
            case .exportHosts, nil: export(from: tableView.cellForRow(at: indexPath))
            }
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

    // MARK: Reorder, edit, remove

    override func tableView(_ tableView: UITableView, canEditRowAt indexPath: IndexPath) -> Bool {
        indexPath.section == Section.hosts.rawValue
    }

    override func tableView(_ tableView: UITableView, canMoveRowAt indexPath: IndexPath) -> Bool {
        indexPath.section == Section.hosts.rawValue && hosts.count > 1
    }

    override func tableView(
        _ tableView: UITableView, editingStyleForRowAt indexPath: IndexPath
    ) -> UITableViewCell.EditingStyle {
        tableView.isEditing ? .none : .delete
    }

    override func tableView(_ tableView: UITableView, shouldIndentWhileEditingRowAt indexPath: IndexPath) -> Bool {
        false
    }

    override func tableView(
        _ tableView: UITableView, targetIndexPathForMoveFromRowAt sourceIndexPath: IndexPath,
        toProposedIndexPath proposedDestinationIndexPath: IndexPath
    ) -> IndexPath {
        // A host only moves among the hosts.
        if proposedDestinationIndexPath.section < Section.hosts.rawValue { return IndexPath(row: 0, section: 0) }
        if proposedDestinationIndexPath.section > Section.hosts.rawValue {
            return IndexPath(row: hosts.count - 1, section: Section.hosts.rawValue)
        }
        return proposedDestinationIndexPath
    }

    override func tableView(_ tableView: UITableView, moveRowAt sourceIndexPath: IndexPath, to destinationIndexPath: IndexPath) {
        ServerStore.move(from: sourceIndexPath.row, to: destinationIndexPath.row)
        hosts = ServerStore.all
    }

    override func tableView(
        _ tableView: UITableView, trailingSwipeActionsConfigurationForRowAt indexPath: IndexPath
    ) -> UISwipeActionsConfiguration? {
        guard indexPath.section == Section.hosts.rawValue else { return nil }
        let host = hosts[indexPath.row]
        let remove = UIContextualAction(style: .destructive, title: String(localized: "hosts.remove")) { [weak self] _, _, done in
            self?.confirmRemove(host)
            done(false)
        }
        let edit = UIContextualAction(style: .normal, title: String(localized: "hosts.edit")) { [weak self] _, _, done in
            self?.edit(host)
            done(true)
        }
        edit.backgroundColor = Palette.primary
        return UISwipeActionsConfiguration(actions: [remove, edit])
    }

    override func tableView(
        _ tableView: UITableView, contextMenuConfigurationForRowAt indexPath: IndexPath, point: CGPoint
    ) -> UIContextMenuConfiguration? {
        guard indexPath.section == Section.hosts.rawValue else { return nil }
        let host = hosts[indexPath.row]
        let index = indexPath.row
        return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
            var actions: [UIMenuElement] = [
                UIAction(title: String(localized: "hosts.edit"), image: UIImage(systemName: "pencil")) { _ in self?.edit(host) }
            ]
            if index > 0 {
                actions.append(UIAction(title: String(localized: "hosts.moveUp"), image: UIImage(systemName: "arrow.up")) { _ in
                    ServerStore.move(from: index, to: index - 1)
                    self?.reload()
                })
            }
            if index < (self?.hosts.count ?? 0) - 1 {
                actions.append(UIAction(title: String(localized: "hosts.moveDown"), image: UIImage(systemName: "arrow.down")) { _ in
                    ServerStore.move(from: index, to: index + 1)
                    self?.reload()
                })
            }
            actions.append(UIAction(
                title: String(localized: "hosts.remove"), image: UIImage(systemName: "trash"), attributes: .destructive
            ) { _ in self?.confirmRemove(host) })
            return UIMenu(children: actions)
        }
    }

    /// Address and name, as the desktop app edits a host. A new address is checked to be a Polaris before it is kept.
    private func edit(_ host: Host, problem: String? = nil, typed: (String, String)? = nil) {
        let ask = UIAlertController(
            title: String(format: String(localized: "hosts.editTitle"), host.label), message: problem, preferredStyle: .alert
        )
        ask.addTextField { field in
            field.text = typed?.0 ?? host.origin
            field.placeholder = String(localized: "hosts.address")
            field.keyboardType = .URL
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
        }
        ask.addTextField { field in
            field.text = typed?.1 ?? host.name
            field.placeholder = String(localized: "hosts.namePlaceholder")
            field.autocapitalizationType = .words
        }
        ask.addAction(UIAlertAction(title: String(localized: "dialog.cancel"), style: .cancel))
        ask.addAction(UIAlertAction(title: String(localized: "hosts.save"), style: .default) { [weak self, weak ask] _ in
            let address = ask?.textFields?.first?.text ?? ""
            let name = ask?.textFields?.last?.text ?? ""
            self?.save(host, address: address, name: name)
        })
        present(ask, animated: true)
    }

    private func save(_ host: Host, address: String, name: String) {
        guard let origin = ServerAddress.origin(address) else {
            edit(host, problem: String(localized: "server.invalid"), typed: (address, name))
            return
        }
        if origin == host.origin {
            ServerStore.rename(host.id, to: name)
            reload()
            return
        }
        if hosts.contains(where: { $0.id != host.id && $0.origin == origin }) {
            edit(host, problem: String(localized: "hosts.taken"), typed: (address, name))
            return
        }
        Task { @MainActor in
            let verdict = await ServerProbe.probe(origin)
            guard verdict == .polaris else {
                self.edit(host, problem: Self.reason(verdict), typed: (address, name))
                return
            }
            guard ServerStore.changeAddress(host.id, to: origin) else {
                self.edit(host, problem: String(localized: "hosts.taken"), typed: (address, name))
                return
            }
            ServerStore.rename(host.id, to: name)
            self.reload()
        }
    }

    private static func reason(_ verdict: ServerProbe.Verdict) -> String {
        switch verdict {
        case .starting: return String(localized: "server.starting")
        case .redirects: return String(localized: "server.redirects")
        case .unreachable: return String(localized: "server.unreachable")
        default: return String(localized: "server.notPolaris")
        }
    }

    /// Removing signs this phone out of it and forgets what it kept, so it is asked first.
    private func confirmRemove(_ host: Host) {
        let ask = UIAlertController(
            title: String(format: String(localized: "hosts.removeTitle"), host.label),
            message: String(localized: "hosts.removeMessage"),
            preferredStyle: .alert
        )
        ask.addAction(UIAlertAction(title: String(localized: "dialog.cancel"), style: .cancel))
        ask.addAction(UIAlertAction(title: String(localized: "hosts.remove"), style: .destructive) { [weak self] _ in
            Task { @MainActor in
                await ServerStore.remove(host.id)
                self?.reload()
                if ServerStore.all.isEmpty { self?.add() }
            }
        })
        present(ask, animated: true)
    }

    // MARK: Import and export

    /// The code the desktop app's Import takes, through the share sheet: Messages to yourself, Mail, Copy.
    private func export(from cell: UITableViewCell?) {
        let entries = hosts.map { HostList.Entry(origin: $0.origin, name: $0.name) }
        guard !entries.isEmpty else { return }
        let share = UIActivityViewController(activityItems: [HostList.encode(entries)], applicationActivities: nil)
        share.popoverPresentationController?.sourceView = cell ?? view
        present(share, animated: true)
    }

    /// A code pasted from another device's Export, or the file it saved. A QR is read by the Camera app instead.
    private func askImport() {
        let ask = UIAlertController(
            title: String(localized: "hosts.importTitle"), message: String(localized: "hosts.importHint"), preferredStyle: .alert
        )
        ask.addTextField { field in
            field.placeholder = "polaris-hosts:..."
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
        }
        ask.addAction(UIAlertAction(title: String(localized: "hosts.importFile"), style: .default) { [weak self] _ in
            self?.pickFile()
        })
        ask.addAction(UIAlertAction(title: String(localized: "dialog.cancel"), style: .cancel))
        ask.addAction(UIAlertAction(title: String(localized: "hosts.import"), style: .default) { [weak self, weak ask] _ in
            self?.take(ask?.textFields?.first?.text)
        })
        present(ask, animated: true)
    }

    private func pickFile() {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.json, .plainText, .data], asCopy: true)
        picker.delegate = self
        picker.allowsMultipleSelection = false
        present(picker, animated: true)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let url = urls.first else { return }
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size <= Self.maxFileBytes, let data = try? Data(contentsOf: url), data.count <= Self.maxFileBytes else {
            take(nil)
            return
        }
        take(String(data: data, encoding: .utf8))
    }

    /// Takes in the hosts a code or file holds, the same way a scanned QR is.
    private func take(_ raw: String?) {
        guard let entries = HostList.read(raw) else {
            tell(String(localized: "link.hostsInvalid"))
            return
        }
        let counts = ServerStore.importHosts(entries)
        reload()
        var said = counts.added > 0
            ? String(format: String(localized: "link.hostsAdded"), counts.added)
            : String(localized: "link.hostsNoneNew")
        if counts.skipped > 0 { said += " " + String(format: String(localized: "link.hostsSkipped"), counts.skipped) }
        tell(said)
    }

    private func tell(_ message: String) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: String(localized: "dialog.ok"), style: .default))
        present(alert, animated: true)
    }
}
