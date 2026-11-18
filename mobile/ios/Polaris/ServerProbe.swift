import Foundation

/// "Is this a Polaris?", the same three questions in the same order as the desktop and Android apps:
/// /api/polaris/identity, then /api/instance for an older install, then /api/health.
enum ServerProbe {
    enum Verdict { case polaris, starting, notPolaris, redirects, unreachable }

    static let timeout: TimeInterval = 5
    static let maxBodyBytes = 4_096

    static func probe(_ origin: String) async -> Verdict {
        let session = URLSession(configuration: .ephemeral, delegate: NoRedirects(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        do {
            let identity = try await ask(session, origin, "/api/polaris/identity")
            if identity.redirect { return .redirects }
            if identity.status == 200 { return isIdentity(identity.body) ? .polaris : .notPolaris }
            if !moveOn(identity.status) { return .notPolaris }

            let instance = try await ask(session, origin, "/api/instance")
            if instance.redirect { return .redirects }
            if instance.status == 200 { return isInstance(instance.body) ? .polaris : .notPolaris }
            if !moveOn(instance.status) { return .notPolaris }

            let health = try await ask(session, origin, "/api/health")
            if health.redirect { return .redirects }
            return healthVerdict(health.status, health.body)
        } catch {
            return .unreachable
        }
    }

    static func isIdentity(_ body: Data?) -> Bool {
        guard let json = object(body), json["product"] as? String == "polaris",
              let protocolVersion = json["protocol"] as? Int else { return false }
        return (1...1_000).contains(protocolVersion)
    }

    static func isInstance(_ body: Data?) -> Bool {
        guard let json = object(body), let id = json["id"] as? String, let key = json["publicKey"] as? String,
              json["addresses"] is [Any] else { return false }
        return id.range(of: "^[A-Za-z0-9_-]{8,64}$", options: .regularExpression) != nil
            && key.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
    }

    static func healthVerdict(_ status: Int, _ body: Data?) -> Verdict {
        let state = object(body)?["status"] as? String
        if status == 200 && state == "ok" { return .polaris }
        if status == 503 && state == "error" { return .starting }
        return .notPolaris
    }

    private static func moveOn(_ status: Int) -> Bool { status == 404 || status == 429 || status == 503 }

    private static func object(_ body: Data?) -> [String: Any]? {
        guard let body else { return nil }
        return (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
    }

    private struct Reply {
        let status: Int
        let body: Data?
        let redirect: Bool
    }

    private static func ask(_ session: URLSession, _ origin: String, _ path: String) async throws -> Reply {
        guard let url = URL(string: origin + path) else { throw URLError(.badURL) }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        if (300..<400).contains(http.statusCode) { return Reply(status: http.statusCode, body: nil, redirect: true) }
        let json = (http.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased().contains("json")
        let body = json && data.count <= maxBodyBytes ? data : nil
        return Reply(status: http.statusCode, body: body, redirect: false)
    }

    /// A probe that follows a redirect would vouch for wherever it landed.
    private final class NoRedirects: NSObject, URLSessionTaskDelegate {
        func urlSession(
            _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
            newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
        ) {
            completionHandler(nil)
        }
    }
}
