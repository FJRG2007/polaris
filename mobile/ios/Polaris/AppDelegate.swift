import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        configurationForConnecting session: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        UISceneConfiguration(name: "Default", sessionRole: session.role)
    }
}

/// The one window: Polaris when the phone knows which one, the address screen when it does not.
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
    }

    func showStart() {
        if let origin = ServerStore.origin {
            window?.rootViewController = WebViewController(origin: origin) { [weak self] in self?.showServer() }
        } else {
            showServer()
        }
    }

    func showServer() {
        window?.rootViewController = ServerViewController { [weak self] in self?.showStart() }
    }
}

/// The dashboard's dark tokens (packages/ui/src/styles/tokens.css), so nothing flashes white on open.
enum Palette {
    static let background = UIColor(red: 0x0B / 255, green: 0x0C / 255, blue: 0x0E / 255, alpha: 1)
    static let foreground = UIColor(red: 0xF3 / 255, green: 0xF4 / 255, blue: 0xF6 / 255, alpha: 1)
    static let muted = UIColor(red: 0xA0 / 255, green: 0xA5 / 255, blue: 0xB1 / 255, alpha: 1)
    static let danger = UIColor(red: 0xDC / 255, green: 0x47 / 255, blue: 0x51 / 255, alpha: 1)
    static let primary = UIColor(red: 0x7E / 255, green: 0x4F / 255, blue: 0xEE / 255, alpha: 1)
}

/// The one Polaris this phone opens, kept between launches.
enum ServerStore {
    private static let key = "server.origin"

    static var origin: String? {
        get { UserDefaults.standard.string(forKey: key) }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }
}
