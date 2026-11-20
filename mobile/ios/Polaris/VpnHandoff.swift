import CryptoKit
import Foundation
import Security
import UIKit

/// The VPN on iPhone, for now: the app makes the key and asks Polaris for a place as the Android app does, then hands
/// the finished configuration to the WireGuard app through the share sheet. Running the tunnel inside Polaris needs a
/// Network Extension, which iOS grants only to apps signed by a paid Apple developer account.
///
/// The private key is made here, kept in the Keychain for this Polaris, and leaves the app only inside that one
/// configuration file, which is deleted as soon as the share sheet closes.
enum VpnHandoff {
    /// What the page sends to connect, as `lib/desktop-bridge.ts` names it.
    struct Connection: Decodable {
        let nodeId: String
        let address: String
        let dns: [String]
        let nodePublicKey: String
        let endpoint: String
        let port: Int
        let own: Own?

        struct Own: Decodable {
            let privateKey: String
            let presharedKey: String?
            let moreAddresses: [String]
            let allowedIps: [String]
            let mtu: Int?
        }
    }

    private static let service = "app.polaris.mobile.vpn"

    /// The public half of this iPhone's key for `origin`, made the first time; nil if the Keychain refuses it.
    static func publicKey(for origin: String) -> String? {
        guard let key = privateKey(for: origin) else { return nil }
        return key.publicKey.rawRepresentation.base64EncodedString()
    }

    /// The WireGuard configuration for `connection`, or nil when anything in it is not what Polaris sends.
    static func configuration(_ connection: Connection, origin: String) -> String? {
        let privateKey: String
        if let own = connection.own {
            privateKey = own.privateKey
        } else if let key = self.privateKey(for: origin) {
            privateKey = key.rawRepresentation.base64EncodedString()
        } else {
            return nil
        }
        let addresses = [connection.address] + (connection.own?.moreAddresses ?? [])
        let routes = connection.own.map { $0.allowedIps.isEmpty ? nil : $0.allowedIps } ?? nil
        let host = connection.endpoint.contains(":") && !connection.endpoint.hasPrefix("[")
            ? "[\(connection.endpoint)]" : connection.endpoint
        var values = [privateKey, connection.nodePublicKey, host] + addresses + connection.dns + (routes ?? [])
        if let preshared = connection.own?.presharedKey { values.append(preshared) }
        // Every value lands on a line of its own in the file: nothing that could start another line or setting.
        guard (1...65535).contains(connection.port), values.allSatisfy(safe) else { return nil }
        var lines = [
            "[Interface]",
            "PrivateKey = \(privateKey)",
            "Address = \(addresses.map(withPrefix).joined(separator: ", "))"
        ]
        if !connection.dns.isEmpty { lines.append("DNS = \(connection.dns.joined(separator: ", "))") }
        if let mtu = connection.own?.mtu, (576...9000).contains(mtu) { lines.append("MTU = \(mtu)") }
        lines += [
            "",
            "[Peer]",
            "PublicKey = \(connection.nodePublicKey)",
            "AllowedIPs = \((routes ?? ["0.0.0.0/0", "::/0"]).joined(separator: ", "))",
            "Endpoint = \(host):\(connection.port)",
            "PersistentKeepalive = 25"
        ]
        if let preshared = connection.own?.presharedKey { lines.append("PresharedKey = \(preshared)") }
        return lines.joined(separator: "\n") + "\n"
    }

    /// Opens the share sheet with the configuration as a file; `done` runs once it closes, whatever was picked.
    static func share(_ configuration: String, from controller: UIViewController, done: @escaping () -> Void) {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("Polaris.conf")
        do {
            try configuration.write(to: file, atomically: true, encoding: .utf8)
        } catch {
            done()
            return
        }
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        sheet.completionWithItemsHandler = { _, _, _, _ in
            try? FileManager.default.removeItem(at: file)
            done()
        }
        sheet.popoverPresentationController?.sourceView = controller.view
        sheet.popoverPresentationController?.sourceRect = CGRect(
            x: controller.view.bounds.midX, y: controller.view.bounds.midY, width: 0, height: 0
        )
        controller.present(sheet, animated: true)
    }

    private static let allowed = CharacterSet(
        charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=.:-_[]"
    )

    private static func safe(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 256 && value.unicodeScalars.allSatisfy { allowed.contains($0) }
    }

    private static func withPrefix(_ address: String) -> String {
        if address.contains("/") { return address }
        return address + (address.contains(":") ? "/128" : "/32")
    }

    private static func privateKey(for origin: String) -> Curve25519.KeyAgreement.PrivateKey? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: origin,
            kSecReturnData as String: true
        ]
        var found: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess,
           let data = found as? Data,
           let key = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: data) {
            return key
        }
        let made = Curve25519.KeyAgreement.PrivateKey()
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: origin,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: made.rawRepresentation
        ]
        SecItemDelete(query.filter { $0.key != kSecReturnData as String } as CFDictionary)
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess ? made : nil
    }
}
