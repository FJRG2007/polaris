import CallKit
import Foundation
import PushKit
import UIKit
import WebKit

/// A Polaris call ringing on the iPhone like a phone call, with the app closed: the system's own call screen, over
/// the lock screen, with Answer and Decline.
///
/// iOS wakes a closed app only for a VoIP push, sent by the Polaris through Apple once its operator has pasted an
/// Apple key on the Integrations screen (`lib/mobile/voip-push.ts`). The token Apple rings this phone on is handed to
/// every Polaris on it, with the session each one already holds in its web data. Without that key nothing arrives
/// here and calls ring only while the app is open, as before.
///
/// iOS ends an app that takes a VoIP push without showing a call, so every push is reported to CallKit at once, even
/// one that cannot be read (it is shown and ended in the same breath). While a call rings, the app listens to the
/// same stream the Android app does (`/api/mobile/notices`) and takes the call screen down when the ring ends there:
/// the caller hung up, somebody else answered, or this person declined on another device.
///
/// Answer opens the conversation with `?answer=1`, exactly as the web's call card does, and the page joins. The call
/// screen stays until the app is on screen, because that is where the microphone is; from the lock screen the
/// Polaris button on it opens the app.
@MainActor
final class IncomingCalls: NSObject {
    static let shared = IncomingCalls()

    private struct Ring {
        let host: Host
        let tag: String
        let meetingId: String
        let path: String
        var answered = false
        var listener: URLSessionDataTask?
        var timeout: Timer?
    }

    private static let tokenKey = "voip.token"
    /// As long as a caller waits before the call gives up, so a ring whose end never arrived stops by itself.
    private static let ringSeconds: TimeInterval = 60

    private let registry = PKPushRegistry(queue: .main)
    private let provider: CXProvider
    private var rings: [UUID: Ring] = [:]
    /// When each host last had the token sent, so page loads do not send it over and over.
    private var sent: [String: Date] = [:]
    private lazy var stream = URLSession(configuration: .default, delegate: StreamReader(owner: self), delegateQueue: .main)

    private override init() {
        let config = CXProviderConfiguration()
        config.supportsVideo = true
        config.maximumCallGroups = 1
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        config.includesCallsInRecents = false
        provider = CXProvider(configuration: config)
        super.init()
        provider.setDelegate(self, queue: .main)
    }

    /// Called at launch, before anything else: a push that woke the app is delivered as soon as this registers.
    func start() {
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.appOnScreen() }
        }
    }

    // MARK: The token

    private var token: String? { UserDefaults.standard.string(forKey: Self.tokenKey) }

    /// Hand this phone's token to a Polaris, with the session the app holds for it. Sent again at most every ten
    /// minutes; the Polaris moves the token to whichever account is signed in now.
    func register(with host: Host) {
        guard let token else { return }
        if let last = sent[host.id], Date().timeIntervalSince(last) < 600 { return }
        sent[host.id] = Date()
        Task { await send(token: token, to: host, method: "POST") }
    }

    private func send(token: String, to host: Host, method: String) async {
        guard let url = URL(string: host.origin + "/api/mobile/voip-token"),
              var request = await authorized(url, for: host) else { return }
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["token": token])
        _ = try? await URLSession.shared.data(for: request)
    }

    /// A request carrying the host's session cookie, and its origin, which its routes check.
    private func authorized(_ url: URL, for host: Host) async -> URLRequest? {
        let cookies = await ServerStore.dataStore(for: host).httpCookieStore.allCookies()
        let mine = cookies.filter { cookie in
            guard let domain = url.host else { return false }
            let bare = cookie.domain.hasPrefix(".") ? String(cookie.domain.dropFirst()) : cookie.domain
            return domain == bare || domain.hasSuffix("." + bare)
        }
        guard !mine.isEmpty else { return nil }
        var request = URLRequest(url: url)
        for (name, value) in HTTPCookie.requestHeaderFields(with: mine) { request.setValue(value, forHTTPHeaderField: name) }
        request.setValue(host.origin, forHTTPHeaderField: "Origin")
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        request.setValue("PolarisMobile/\(version) (iOS)", forHTTPHeaderField: "User-Agent")
        return request
    }

    // MARK: A ring

    fileprivate func ring(_ payload: [AnyHashable: Any], completion: @escaping () -> Void) {
        let id = UUID()
        let caller = (payload["caller"] as? String).flatMap { $0.isEmpty ? nil : String($0.prefix(120)) } ?? "Polaris"
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: caller)
        update.localizedCallerName = caller
        update.hasVideo = false
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false

        let origin = payload["origin"] as? String ?? ""
        let host = ServerStore.find(origin: origin) ?? ServerStore.active
        let channel = payload["channelId"] as? String ?? ""
        let meetingId = payload["meetingId"] as? String ?? ""
        let readable = host != nil
            && channel.range(of: "^[A-Za-z0-9-]{1,100}$", options: .regularExpression) != nil
            && meetingId.range(of: "^[0-9a-f-]{36}$", options: .regularExpression) != nil

        provider.reportNewIncomingCall(with: id, update: update) { [weak self] error in
            let refused = error != nil
            // CallKit answers on the provider's queue, which is the main one (`setDelegate`).
            MainActor.assumeIsolated {
                self?.reported(id, refused: refused, host: readable ? host : nil, channel: channel, meetingId: meetingId)
            }
            completion()
        }
    }

    private func reported(_ id: UUID, refused: Bool, host: Host?, channel: String, meetingId: String) {
        if refused { return }
        guard let host else {
            // Shown, because iOS insists, and ended at once: nothing here can be answered.
            provider.reportCall(with: id, endedAt: nil, reason: .failed)
            return
        }
        var ring = Ring(host: host, tag: "call:\(channel)", meetingId: meetingId, path: "/chat/c/\(channel)")
        ring.timeout = Timer.scheduledTimer(withTimeInterval: Self.ringSeconds, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.end(id, reason: .unanswered) }
        }
        rings[id] = ring
        listen(id)
    }

    /// The ring's end, as the Polaris says it: the same stream the Android app keeps open.
    private func listen(_ id: UUID) {
        guard let ring = rings[id], let url = URL(string: ring.host.origin + "/api/mobile/notices") else { return }
        Task {
            guard var request = await authorized(url, for: ring.host) else { return }
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            request.timeoutInterval = Self.ringSeconds + 5
            let task = stream.dataTask(with: request)
            task.taskDescription = id.uuidString
            rings[id]?.listener = task
            task.resume()
        }
    }

    fileprivate func heard(_ frame: [String: Any], on task: URLSessionTask) {
        guard let raw = task.taskDescription, let id = UUID(uuidString: raw), let ring = rings[id],
              !ring.answered, frame["kind"] as? String == "call-ended", frame["tag"] as? String == ring.tag else { return }
        end(id, reason: .remoteEnded)
    }

    /// The call screen down, wherever the ring ended.
    private func end(_ id: UUID, reason: CXCallEndedReason) {
        guard let ring = rings.removeValue(forKey: id) else { return }
        ring.timeout?.invalidate()
        ring.listener?.cancel()
        provider.reportCall(with: id, endedAt: nil, reason: reason)
    }

    /// An answered call hands over to the page as soon as the app is on screen, where the microphone is.
    private func appOnScreen() {
        for (id, ring) in rings where ring.answered {
            rings.removeValue(forKey: id)
            ring.timeout?.invalidate()
            ring.listener?.cancel()
            provider.reportCall(with: id, endedAt: nil, reason: .answeredElsewhere)
        }
    }

    private func decline(_ ring: Ring) {
        guard let url = URL(string: ring.host.origin + "/api/chat/calls/decline") else { return }
        let meetingId = ring.meetingId
        Task {
            guard var request = await authorized(url, for: ring.host) else { return }
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: ["meetingId": meetingId])
            _ = try? await URLSession.shared.data(for: request)
        }
    }
}

extension IncomingCalls: PKPushRegistryDelegate {
    nonisolated func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
        let token = credentials.token.map { String(format: "%02x", $0) }.joined()
        MainActor.assumeIsolated {
            let changed = UserDefaults.standard.string(forKey: Self.tokenKey) != token
            UserDefaults.standard.set(token, forKey: Self.tokenKey)
            if changed { sent.removeAll() }
            for host in ServerStore.all { register(with: host) }
        }
    }

    nonisolated func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        MainActor.assumeIsolated {
            if let token {
                for host in ServerStore.all { Task { await send(token: token, to: host, method: "DELETE") } }
            }
            UserDefaults.standard.removeObject(forKey: Self.tokenKey)
            sent.removeAll()
        }
    }

    nonisolated func pushRegistry(
        _ registry: PKPushRegistry,
        didReceiveIncomingPushWith payload: PKPushPayload,
        for type: PKPushType,
        completion: @escaping () -> Void
    ) {
        let body = payload.dictionaryPayload
        MainActor.assumeIsolated { ring(body, completion: completion) }
    }
}

extension IncomingCalls: CXProviderDelegate {
    nonisolated func providerDidReset(_ provider: CXProvider) {
        MainActor.assumeIsolated {
            for (_, ring) in rings {
                ring.timeout?.invalidate()
                ring.listener?.cancel()
            }
            rings.removeAll()
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        MainActor.assumeIsolated {
            guard var ring = rings[action.callUUID] else {
                action.fail()
                return
            }
            ring.answered = true
            ring.timeout?.invalidate()
            ring.listener?.cancel()
            rings[action.callUUID] = ring
            action.fulfill()
            ServerStore.select(ring.host.id)
            let scene = UIApplication.shared.connectedScenes.first?.delegate as? SceneDelegate
            scene?.showStart(path: ring.path + "?answer=1")
            if UIApplication.shared.applicationState == .active { appOnScreen() }
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        MainActor.assumeIsolated {
            if let ring = rings.removeValue(forKey: action.callUUID) {
                ring.timeout?.invalidate()
                ring.listener?.cancel()
                // Declined while it rang: every other device of this account stops ringing too.
                if !ring.answered { decline(ring) }
            }
            action.fulfill()
        }
    }
}

/// Reads the notices stream line by line, handing each `data:` frame to the rings.
private final class StreamReader: NSObject, URLSessionDataDelegate {
    private weak var owner: IncomingCalls?
    private var buffers: [Int: String] = [:]

    init(owner: IncomingCalls) { self.owner = owner }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        var text = (buffers[dataTask.taskIdentifier] ?? "") + (String(data: data, encoding: .utf8) ?? "")
        while let cut = text.range(of: "\n\n") {
            let frame = String(text[..<cut.lowerBound])
            text = String(text[cut.upperBound...])
            for line in frame.split(separator: "\n") where line.hasPrefix("data:") {
                let json = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                guard let parsed = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { continue }
                MainActor.assumeIsolated { owner?.heard(parsed, on: dataTask) }
            }
        }
        // A stream that never sends a frame end is not kept growing.
        buffers[dataTask.taskIdentifier] = text.count > 65_536 ? "" : text
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        buffers.removeValue(forKey: task.taskIdentifier)
    }
}
