import UIKit

/// Every Polaris this phone opens: tap one to open it, swipe to rename or remove it, or add another. Each is signed
/// in on its own, so switching never signs anybody out. A desktop app's servers QR, read with the camera, adds all of
/// its servers here at once.
final class HostsViewController: UITableViewController {
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
        title = String(localized: "hosts.title")
        view.backgroundColor = Palette.background
        tableView.backgroundColor = Palette.background
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "host")
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            systemItem: .add, primaryAction: UIAction { [weak self] _ in self?.add() }
        )
        if ServerStore.active != nil {
            navigationItem.leftBarButtonItem = UIBarButtonItem(
                title: String(localized: "dialog.cancel"), primaryAction: UIAction { [weak self] _ in self?.open() }
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

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { hosts.count }

    override func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? {
        String(localized: "hosts.scanHint")
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "host", for: indexPath)
        let host = hosts[indexPath.row]
        var content = UIListContentConfiguration.subtitleCell()
        content.text = host.label
        content.secondaryText = host.origin
        content.textProperties.color = Palette.foreground
        content.textProperties.font = Plex.font(.medium, 16, .body)
        content.secondaryTextProperties.color = Palette.muted
        content.secondaryTextProperties.font = Plex.font(.regular, 13, .footnote)
        content.textProperties.numberOfLines = 1
        content.secondaryTextProperties.numberOfLines = 1
        cell.contentConfiguration = content
        cell.backgroundColor = Palette.field
        cell.accessoryType = host.id == ServerStore.active?.id ? .checkmark : .none
        cell.tintColor = Palette.primary
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        ServerStore.select(hosts[indexPath.row].id)
        open()
    }

    override func tableView(
        _ tableView: UITableView, trailingSwipeActionsConfigurationForRowAt indexPath: IndexPath
    ) -> UISwipeActionsConfiguration? {
        let host = hosts[indexPath.row]
        let remove = UIContextualAction(style: .destructive, title: String(localized: "hosts.remove")) { [weak self] _, _, done in
            self?.confirmRemove(host)
            done(false)
        }
        let rename = UIContextualAction(style: .normal, title: String(localized: "hosts.rename")) { [weak self] _, _, done in
            self?.askName(host)
            done(true)
        }
        rename.backgroundColor = Palette.primary
        return UISwipeActionsConfiguration(actions: [remove, rename])
    }

    private func askName(_ host: Host) {
        let ask = UIAlertController(title: String(localized: "hosts.rename"), message: host.origin, preferredStyle: .alert)
        ask.addTextField { field in
            field.text = host.name
            field.placeholder = URL(string: host.origin)?.host
        }
        ask.addAction(UIAlertAction(title: String(localized: "dialog.cancel"), style: .cancel))
        ask.addAction(UIAlertAction(title: String(localized: "dialog.ok"), style: .default) { [weak self, weak ask] _ in
            ServerStore.rename(host.id, to: ask?.textFields?.first?.text)
            self?.reload()
        })
        present(ask, animated: true)
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
}
