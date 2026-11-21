import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        // First thing: a call that woke the app is handed over as soon as this registers.
        IncomingCalls.shared.start()
        return true
    }

    func application(
        _ application: UIApplication,
        configurationForConnecting session: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        UISceneConfiguration(name: "Default", sessionRole: session.role)
    }
}

/// The one window: the Polaris the phone opens now, the address screen when it has none, and the list of them when
/// asked for. `polaris://` links land here too, from the camera reading a desktop app's QR or a link followed in Safari.
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.backgroundColor = Palette.background
        window.overrideUserInterfaceStyle = .dark
        self.window = window
        showStart()
        window.makeKeyAndVisible()
        if let url = options.urlContexts.first?.url { open(url) }
    }

    func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
        if let url = contexts.first?.url { open(url) }
    }

    /// The Polaris open now, on `path` when one is given.
    func showStart(path: String? = nil) {
        if let host = ServerStore.active {
            window?.rootViewController = WebViewController(host: host, path: path) { [weak self] in self?.showHosts() }
        } else {
            showServer()
        }
    }

    func showServer() {
        window?.rootViewController = ServerViewController { [weak self] in self?.showStart() }
    }

    /// Every Polaris on this phone.
    func showHosts() {
        let list = HostsViewController(
            open: { [weak self] in self?.showStart() },
            add: { [weak self] in self?.showServer() }
        )
        window?.rootViewController = UINavigationController(rootViewController: list)
    }

    // MARK: Links

    private func open(_ url: URL) {
        let link = url.absoluteString
        if link.lowercased().hasPrefix(HostList.link) {
            takeHosts(link)
        } else if let page = DeepLink.read(link) {
            openPage(page)
        } else {
            tell(String(localized: "link.invalid"))
        }
    }

    /// Every host on a desktop app's QR, taken in at once - on a phone with none yet as much as on one with some.
    private func takeHosts(_ link: String) {
        guard let hosts = HostList.read(link) else {
            tell(String(localized: "link.hostsInvalid"))
            return
        }
        let counts = ServerStore.importHosts(hosts)
        showHosts()
        var said = counts.added > 0
            ? String(format: String(localized: "link.hostsAdded"), counts.added)
            : String(localized: "link.hostsNoneNew")
        if counts.skipped > 0 { said += " " + String(format: String(localized: "link.hostsSkipped"), counts.skipped) }
        tell(said)
    }

    /// A page of a Polaris on this phone opens here; one that is not is added only after a yes and a check that it
    /// really is a Polaris, since a link can name any address at all.
    private func openPage(_ page: DeepLink) {
        if let host = ServerStore.find(origin: page.server) {
            ServerStore.select(host.id)
            showStart(path: page.path)
            return
        }
        let name = URL(string: page.server)?.host ?? page.server
        let ask = UIAlertController(
            title: String(format: String(localized: "link.addTitle"), name),
            message: String(localized: "link.addMessage"),
            preferredStyle: .alert
        )
        ask.addAction(UIAlertAction(title: String(localized: "dialog.cancel"), style: .cancel))
        ask.addAction(UIAlertAction(title: String(localized: "link.addConfirm"), style: .default) { [weak self] _ in
            Task { @MainActor in
                let verdict = await ServerProbe.probe(page.server)
                if verdict == .polaris {
                    ServerStore.add(page.server)
                    self?.showStart(path: page.path)
                } else {
                    self?.tell(verdict == .unreachable
                        ? String(localized: "server.unreachable") : String(localized: "server.notPolaris"))
                }
            }
        })
        present(ask)
    }

    private func tell(_ text: String) {
        let note = UIAlertController(title: nil, message: text, preferredStyle: .alert)
        note.addAction(UIAlertAction(title: String(localized: "dialog.ok"), style: .default))
        present(note)
    }

    private func present(_ controller: UIViewController) {
        var top = window?.rootViewController
        while let shown = top?.presentedViewController { top = shown }
        top?.present(controller, animated: true)
    }
}

/// The dashboard's dark tokens (packages/ui/src/styles/tokens.css), so nothing flashes white on open.
enum Palette {
    static let background = UIColor(red: 0x0B / 255, green: 0x0C / 255, blue: 0x0E / 255, alpha: 1)
    static let foreground = UIColor(red: 0xF3 / 255, green: 0xF4 / 255, blue: 0xF6 / 255, alpha: 1)
    static let muted = UIColor(red: 0xA0 / 255, green: 0xA5 / 255, blue: 0xB1 / 255, alpha: 1)
    static let danger = UIColor(red: 0xDC / 255, green: 0x47 / 255, blue: 0x51 / 255, alpha: 1)
    static let primary = UIColor(red: 0x7E / 255, green: 0x4F / 255, blue: 0xEE / 255, alpha: 1)
    static let field = UIColor(red: 0x10 / 255, green: 0x11 / 255, blue: 0x14 / 255, alpha: 1)
    static let border = UIColor(red: 0x25 / 255, green: 0x27 / 255, blue: 0x2D / 255, alpha: 1)
    static let mutedSurface = UIColor(red: 0x20 / 255, green: 0x22 / 255, blue: 0x27 / 255, alpha: 1)
}

/// IBM Plex Sans, the dashboard's face, scaled with the reader's text size.
enum Plex {
    static func font(_ weight: UIFont.Weight, _ size: CGFloat, _ style: UIFont.TextStyle) -> UIFont {
        let name = weight == .semibold ? "IBMPlexSans-SemiBold" : weight == .medium ? "IBMPlexSans-Medium" : "IBMPlexSans"
        let base = UIFont(name: name, size: size) ?? .systemFont(ofSize: size, weight: weight)
        return UIFontMetrics(forTextStyle: style).scaledFont(for: base)
    }
}

/// The dashboard's buttons: primary is the filled purple one, ghost has no chrome until pressed.
enum PolarisButton {
    static func primary(_ title: String, _ action: UIAction) -> UIButton {
        make(title, action, background: Palette.primary, foreground: .white)
    }

    static func ghost(_ title: String, _ action: UIAction) -> UIButton {
        make(title, action, background: .clear, foreground: Palette.muted)
    }

    private static func make(_ title: String, _ action: UIAction, background: UIColor, foreground: UIColor) -> UIButton {
        var style = UIButton.Configuration.filled()
        style.cornerStyle = .fixed
        style.background.cornerRadius = 8
        style.baseBackgroundColor = background
        style.baseForegroundColor = foreground
        style.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 20, bottom: 12, trailing: 20)
        style.attributedTitle = AttributedString(title, attributes: AttributeContainer([.font: Plex.font(.medium, 15, .body)]))
        let button = UIButton(configuration: style, primaryAction: action)
        button.configurationUpdateHandler = { button in
            var next = button.configuration
            let pressed = button.isHighlighted
            next?.background.backgroundColor = background == .clear
                ? (pressed ? Palette.mutedSurface : .clear)
                : background.withAlphaComponent(button.isEnabled ? (pressed ? 0.8 : 1) : 0.45)
            button.configuration = next
        }
        return button
    }
}

/// The dashboard's input: bg-field, a border, rounded-md, the primary ring while it is being typed in.
final class PolarisField: UITextField {
    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = Palette.field
        textColor = Palette.foreground
        tintColor = Palette.primary
        font = Plex.font(.regular, 16, .body)
        adjustsFontForContentSizeCategory = true
        layer.cornerRadius = 8
        layer.borderWidth = 1
        layer.borderColor = Palette.border.cgColor
        heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
        addAction(UIAction { [weak self] _ in self?.layer.borderColor = Palette.primary.cgColor }, for: .editingDidBegin)
        addAction(UIAction { [weak self] _ in self?.layer.borderColor = Palette.border.cgColor }, for: .editingDidEnd)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    func setHint(_ text: String) {
        attributedPlaceholder = NSAttributedString(string: text, attributes: [.foregroundColor: Palette.muted])
    }

    override func textRect(forBounds bounds: CGRect) -> CGRect { bounds.insetBy(dx: 14, dy: 0) }
    override func editingRect(forBounds bounds: CGRect) -> CGRect { bounds.insetBy(dx: 14, dy: 0) }
}
