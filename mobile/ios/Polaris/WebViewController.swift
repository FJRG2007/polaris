import UIKit
import WebKit

/// Polaris itself: the instance the phone was pointed at, signed in like Safari and kept signed in. The app adds the
/// camera and microphone for calls, swipe back, and links to anywhere else opening in Safari instead of inside
/// Polaris.
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private let origin: String
    private let changeServer: () -> Void
    private var web: WKWebView!
    private let failure = UIStackView()
    private let failureText = UILabel()

    init(origin: String, changeServer: @escaping () -> Void) {
        self.origin = origin
        self.changeServer = changeServer
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Palette.background

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        // A call starts its audio from a tap that already happened on the page.
        config.mediaTypesRequiringUserActionForPlayback = []
        // How the instance tells this app from Safari on its sessions screen.
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        config.applicationNameForUserAgent = "PolarisMobile/\(version) (iOS)"
        let bridge = """
        window.polarisMobile = Object.freeze({
            platform: function () { return "ios"; },
            version: function () { return "\(version)"; },
            changeServer: function () { window.webkit.messageHandlers.polarisMobile.postMessage("changeServer"); }
        });
        """
        config.userContentController.addUserScript(
            WKUserScript(source: bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        )
        config.userContentController.add(WeakHandler(self), name: "polarisMobile")

        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        web.isOpaque = false
        web.backgroundColor = Palette.background
        web.scrollView.contentInsetAdjustmentBehavior = .automatic
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)

        let refresh = UIRefreshControl()
        refresh.addAction(UIAction { [weak self] _ in
            self?.web.reload()
            refresh.endRefreshing()
        }, for: .valueChanged)
        web.scrollView.refreshControl = refresh

        buildFailure()
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            web.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])

        if let url = URL(string: origin + "/") { web.load(URLRequest(url: url)) }
    }

    private func buildFailure() {
        let title = UILabel()
        title.text = String(localized: "page.unreachableTitle")
        title.font = .preferredFont(forTextStyle: .headline)
        title.textColor = Palette.foreground
        failureText.font = .preferredFont(forTextStyle: .subheadline)
        failureText.textColor = Palette.muted
        failureText.numberOfLines = 0
        failureText.textAlignment = .center

        var retryStyle = UIButton.Configuration.filled()
        retryStyle.baseBackgroundColor = Palette.primary
        retryStyle.title = String(localized: "page.retry")
        let retry = UIButton(configuration: retryStyle, primaryAction: UIAction { [weak self] _ in
            self?.failure.isHidden = true
            self?.web.reload()
        })
        var otherStyle = UIButton.Configuration.plain()
        otherStyle.title = String(localized: "page.changeServer")
        let other = UIButton(configuration: otherStyle, primaryAction: UIAction { [weak self] _ in
            self?.changeServer()
        })

        [title, failureText, retry, other].forEach(failure.addArrangedSubview)
        failure.axis = .vertical
        failure.alignment = .center
        failure.spacing = 12
        failure.isHidden = true
        failure.backgroundColor = Palette.background
        failure.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(failure)
        NSLayoutConstraint.activate([
            failure.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            failure.leadingAnchor.constraint(equalTo: view.readableContentGuide.leadingAnchor),
            failure.trailingAnchor.constraint(equalTo: view.readableContentGuide.trailingAnchor)
        ])
    }

    // MARK: Navigation

    func webView(
        _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        // Only the main frame leaves: an embedded frame of another site stays where the page put it.
        if ServerAddress.sameOrigin(origin, url) || action.targetFrame?.isMainFrame == false
            || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" {
            return decisionHandler(.allow)
        }
        UIApplication.shared.open(url)
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        failureText.text = String(format: String(localized: "page.unreachable"), origin)
        failure.isHidden = false
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    /// A link that asks for a new window opens here, or in Safari when it leaves Polaris.
    func webView(
        _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
        for action: WKNavigationAction, windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = action.request.url {
            if ServerAddress.sameOrigin(origin, url) { webView.load(action.request) } else { UIApplication.shared.open(url) }
        }
        return nil
    }

    // MARK: Calls

    /// Only the instance itself may ask for the camera or the microphone; iOS still asks the person once.
    func webView(
        _ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        let port = origin.port == 0 ? "" : ":\(origin.port)"
        let asking = ServerAddress.origin("\(origin.protocol)://\(origin.host)\(port)")
        decisionHandler(asking == self.origin ? .grant : .deny)
    }

    // MARK: Page dialogs, drawn natively since a web view has none of its own

    func webView(
        _ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void
    ) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: String(localized: "dialog.ok"), style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(
        _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void
    ) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: String(localized: "dialog.cancel"), style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: String(localized: "dialog.ok"), style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }

    // MARK: Bridge

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, ServerAddress.sameOrigin(origin, message.frameInfo.request.url) else { return }
        if message.body as? String == "changeServer" { changeServer() }
    }
}

/// The content controller keeps its handlers alive; this keeps it from keeping the page alive with them.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) { self.target = target }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
