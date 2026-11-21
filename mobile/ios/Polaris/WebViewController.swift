import UIKit
import WebKit

/// Polaris itself: the instance the phone was pointed at, signed in like Safari and kept signed in. The app adds the
/// camera and microphone for calls, swipe back, and links to anywhere else opening in Safari instead of inside
/// Polaris.
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private let host: Host
    private var origin: String { host.origin }
    /// The page to open first, from a `polaris://open` link; the start otherwise.
    private let path: String?
    private let changeServer: () -> Void
    private var web: WKWebView!
    private let failure = UIStackView()
    private let failureText = UILabel()
    /// While Polaris is not answering (an update restarting it), the page is tried again on its own: every few
    /// seconds at first, then less often, so it comes back as soon as Polaris does without anybody pressing a button.
    private var retry: Timer?
    private var retries = 0
    /// The phone's gallery for chat's "+" sheet, made the first time the page asks.
    private lazy var media = DeviceMedia(presenter: self) { [weak self] id, result in self?.mediaAnswer(id, result) }
    /// While the page shows something private (a profile photo full size): the page is covered whenever the screen
    /// is being recorded or mirrored, and in the app switcher's snapshot. iOS lets no app refuse a screenshot.
    private var protecting = false
    private let shield = UIView()

    init(host: Host, path: String? = nil, changeServer: @escaping () -> Void) {
        self.host = host
        self.path = path
        self.changeServer = changeServer
        super.init(nibName: nil, bundle: nil)
    }

    deinit { retry?.invalidate() }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Palette.background

        let config = WKWebViewConfiguration()
        // Each Polaris in its own cookies and storage where iOS allows it (`ServerStore.dataStore`).
        config.websiteDataStore = ServerStore.dataStore(for: host)
        config.allowsInlineMediaPlayback = true
        // A call starts its audio from a tap that already happened on the page.
        config.mediaTypesRequiringUserActionForPlayback = []
        // How the instance tells this app from Safari on its sessions screen.
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        config.applicationNameForUserAgent = "PolarisMobile/\(version) (iOS)"
        // The VPN's public key, ready before the page asks: the bridge answers it without a round trip.
        let vpnKey = VpnHandoff.publicKey(for: origin) ?? ""
        let bridge = """
        window.polarisMobile = Object.freeze({
            platform: function () { return "ios"; },
            version: function () { return "\(version)"; },
            changeServer: function () { window.webkit.messageHandlers.polarisMobile.postMessage("changeServer"); },
            openExternal: function (url) { window.webkit.messageHandlers.polarisMobile.postMessage({ openExternal: String(url) }); },
            canVpn: function () { return \(vpnKey.isEmpty ? "false" : "true"); },
            vpnDeviceName: function () { return \(Self.jsString(UIDevice.current.name)); },
            vpnKey: function () { return \(Self.jsString(vpnKey)); },
            vpnStatus: function () { return '{"nodeId":null}'; },
            vpnUp: function (id, input) {
                window.webkit.messageHandlers.polarisMobile.postMessage({ kind: "vpnUp", id: String(id), input: String(input) });
            },
            vpnDown: function (id) {
                window.webkit.messageHandlers.polarisMobile.postMessage({ kind: "vpnDown", id: String(id) });
            },
            canMedia: function () { return true; },
            mediaCall: function (id, op, args) {
                window.webkit.messageHandlers.polarisMobile.postMessage({ kind: "media", id: String(id), op: String(op), args: String(args) });
            },
            swipeBack: function (available) {
                window.webkit.messageHandlers.polarisMobile.postMessage(available ? "swipeBack:on" : "swipeBack:off");
            },
            protectScreen: function (on) {
                window.webkit.messageHandlers.polarisMobile.postMessage(on ? "protect:on" : "protect:off");
            },
            setSeasonIcon: function (season) {
                window.webkit.messageHandlers.polarisMobile.postMessage({ seasonIcon: String(season) });
            }
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

        shield.backgroundColor = Palette.background
        shield.isHidden = true
        shield.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(shield)
        NSLayoutConstraint.activate([
            shield.topAnchor.constraint(equalTo: view.topAnchor),
            shield.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            shield.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            shield.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(updateShield), name: UIScreen.capturedDidChangeNotification, object: nil)
        center.addObserver(self, selector: #selector(coverForSwitcher), name: UIApplication.willResignActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(updateShield), name: UIApplication.didBecomeActiveNotification, object: nil)

        if let url = URL(string: origin + (path ?? "/")) { web.load(URLRequest(url: url)) }
    }

    private func protect(_ on: Bool) {
        protecting = on
        updateShield()
    }

    @objc private func updateShield() {
        shield.isHidden = !(protecting && (view.window?.screen ?? UIScreen.main).isCaptured)
    }

    /// The app switcher keeps a picture of the screen as the app leaves it.
    @objc private func coverForSwitcher() {
        if protecting { shield.isHidden = false }
    }

    private func buildFailure() {
        let title = UILabel()
        title.text = String(localized: "page.unreachableTitle")
        title.font = Plex.font(.semibold, 18, .headline)
        title.textColor = Palette.foreground
        failureText.font = Plex.font(.regular, 15, .subheadline)
        failureText.textColor = Palette.muted
        failureText.numberOfLines = 0
        failureText.textAlignment = .center

        let retry = PolarisButton.primary(String(localized: "page.retry"), UIAction { [weak self] _ in
            self?.tryAgain()
        })
        let other = PolarisButton.ghost(String(localized: "page.changeServer"), UIAction { [weak self] _ in
            self?.changeServer()
        })

        let waiting = UILabel()
        waiting.text = String(localized: "page.retrying")
        waiting.font = Plex.font(.regular, 13, .footnote)
        waiting.textColor = Palette.muted
        waiting.numberOfLines = 0
        waiting.textAlignment = .center

        [title, failureText, waiting, retry, other].forEach(failure.addArrangedSubview)
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
        scheduleRetry()
    }

    /// A gateway error from the edge in front of Polaris is the same outage as no answer at all.
    func webView(
        _ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        if response.isForMainFrame, let http = response.response as? HTTPURLResponse,
           [502, 503, 504].contains(http.statusCode) {
            failureText.text = String(format: String(localized: "page.unreachable"), origin)
            failure.isHidden = false
            scheduleRetry()
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        // A new document says for itself whether it has a back; until it does, the history swipe is the back.
        webView.allowsBackForwardNavigationGestures = true
        // Nor does it inherit a protection the last one asked for and never got to release.
        protect(false)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        retry?.invalidate()
        retry = nil
        retries = 0
        failure.isHidden = true
        // Signed in by now, or still: the Polaris learns which phone to ring for this account.
        IncomingCalls.shared.register(with: host)
    }

    private func scheduleRetry() {
        retry?.invalidate()
        let delay: TimeInterval = retries < 20 ? 3 : 15
        retries += 1
        retry = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.tryAgain() }
        }
    }

    private func tryAgain() {
        retry?.invalidate()
        retry = nil
        if let url = web.url, ServerAddress.sameOrigin(origin, url) {
            web.reload()
        } else if let url = URL(string: origin + (path ?? "/")) {
            web.load(URLRequest(url: url))
        }
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
        // The page has a back of its own on screen - a conversation's arrow, a folder's parent - and slides the
        // screen away under the finger itself; the history swipe would go somewhere else (the conversation opened
        // before this one, not the list), so it steps aside while the page's is there.
        if let flag = message.body as? String, flag.hasPrefix("protect:") {
            return protect(flag == "protect:on")
        }
        if let flag = message.body as? String, flag.hasPrefix("swipeBack:") {
            web.allowsBackForwardNavigationGestures = flag != "swipeBack:on"
            return
        }
        // A link the page opens outside itself: a WebView has no tabs, and a link in a sandboxed frame (a mail
        // body) cannot open a window of its own. Only the web and mail leave.
        if let body = message.body as? [String: Any], let raw = body["openExternal"] as? String,
           let url = Self.externalURL(raw) {
            UIApplication.shared.open(url)
            return
        }
        // The season the page decorates with, for the app icon (SeasonIcon).
        if let body = message.body as? [String: Any], let season = body["seasonIcon"] as? String {
            if season.count <= 32 { SeasonIcon.apply(season) }
            return
        }
        guard let body = message.body as? [String: Any], let kind = body["kind"] as? String,
              let id = body["id"] as? String, id.count <= 40,
              id.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) || $0 == "-" }) else { return }
        if kind == "media" {
            guard let op = body["op"] as? String, op.count <= 16, let raw = (body["args"] as? String)?.data(using: .utf8),
                  raw.count <= 1024 else { return }
            let args = (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any] ?? [:]
            return media.call(id: id, op: op, args: args)
        }
        if kind == "vpnDown" { return vpnAnswer(id, "") }
        guard kind == "vpnUp", let input = (body["input"] as? String)?.data(using: .utf8), input.count <= 16 * 1024,
              let connection = try? JSONDecoder().decode(VpnHandoff.Connection.self, from: input),
              let configuration = VpnHandoff.configuration(connection, origin: origin) else {
            return vpnAnswer(id, "failed")
        }
        // No tunnel of its own yet (see VpnHandoff): the WireGuard app takes it from the share sheet.
        VpnHandoff.share(configuration, from: self) { [weak self] in self?.vpnAnswer(id, "handedOff") }
    }

    /// The address as a web or mail link, or nil for any other scheme, which would launch whatever app claims it.
    static func externalURL(_ raw: String) -> URL? {
        guard raw.count <= 20_000, let url = URL(string: raw), let scheme = url.scheme?.lowercased() else { return nil }
        switch scheme {
        case "http", "https": return (url.host ?? "").isEmpty ? nil : url
        case "mailto": return url
        default: return nil
        }
    }

    /// How one VPN request of the page's ended: "" when it worked, else a code the page puts in words.
    private func vpnAnswer(_ id: String, _ error: String) {
        let call = "window.__polarisMobileVpn && window.__polarisMobileVpn(\(Self.jsString(id)), \(Self.jsString(error)))"
        web.evaluateJavaScript(call, completionHandler: nil)
    }

    /// One answer to the page's gallery: a JSON object, which can carry a chunk of a photo.
    private func mediaAnswer(_ id: String, _ result: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: result),
              let json = String(data: data, encoding: .utf8) else { return }
        let call = "window.__polarisMobileMedia && window.__polarisMobileMedia(\(Self.jsString(id)), \(Self.jsString(json)))"
        web.evaluateJavaScript(call, completionHandler: nil)
    }

    /// A string as a JavaScript literal.
    private static func jsString(_ value: String) -> String {
        guard let data = try? JSONEncoder().encode([value]), let array = String(data: data, encoding: .utf8) else { return "\"\"" }
        return String(array.dropFirst().dropLast())
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
