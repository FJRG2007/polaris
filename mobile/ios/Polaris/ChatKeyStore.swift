import CryptoKit
import Foundation
import Security
import WebKit

/// The page's `polarisKeyStore` message handler: the chat account key's device lock sealed with AES-256-GCM under a
/// key kept in this iPhone's Keychain, for this device only and never in a backup (docs/chat-e2ee-phase1.md, "Native
/// key stores"). A copy of the app's web data opens nothing elsewhere.
///
/// Silent by design - the account key must open as the page loads - so the key is readable after the first unlock
/// since boot, not behind Face ID. Each sealed value is bound to the server it was sealed for (the origin is the GCM
/// authenticated data), and only the server's own main frame is answered. Every failure replies null, which the page
/// reads as "no device copy" and recovers from the password, a passkey or another device.
final class ChatKeyStore: NSObject, WKScriptMessageHandlerWithReply {
    private static let service = "app.polaris.mobile.chat-key-wrap"
    private static let account = "device-lock"
    private static let maxText = 4096

    private let origin: String

    init(origin: String) {
        self.origin = origin
    }

    func userContentController(
        _ controller: WKUserContentController, didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard message.frameInfo.isMainFrame, ServerAddress.sameOrigin(origin, message.frameInfo.request.url),
              let body = message.body as? [String: Any], let op = body["op"] as? String,
              let data = body["data"] as? String, let input = Self.decode(data)
        else { return replyHandler(nil, nil) }
        let bound = Data(origin.utf8)
        switch op {
        case "seal":
            guard let key = Self.key(), let box = try? AES.GCM.seal(input, using: key, authenticating: bound),
                  let combined = box.combined
            else { return replyHandler(nil, nil) }
            replyHandler(Self.encode(combined), nil)
        case "open":
            guard let key = Self.key(), let box = try? AES.GCM.SealedBox(combined: input),
                  let plain = try? AES.GCM.open(box, using: key, authenticating: bound)
            else { return replyHandler(nil, nil) }
            replyHandler(Self.encode(plain), nil)
        default:
            replyHandler(nil, nil)
        }
    }

    /// The Keychain key, made on first use. Nil when the Keychain cannot be read (before the first unlock).
    private static func key() -> SymmetricKey? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var found: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &found)
        if status == errSecSuccess, let bytes = found as? Data, bytes.count == 32 { return SymmetricKey(data: bytes) }
        guard status == errSecItemNotFound else { return nil }
        let fresh = SymmetricKey(size: .bits256)
        let bytes = fresh.withUnsafeBytes { Data($0) }
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: bytes
        ]
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess ? fresh : nil
    }

    private static func decode(_ text: String) -> Data? {
        guard !text.isEmpty, text.count <= maxText,
              text.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) && $0.isASCII || $0 == "-" || $0 == "_" })
        else { return nil }
        var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        return Data(base64Encoded: base64)
    }

    private static func encode(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
