import Foundation
import Security

/// The Mac this phone is paired with: its address, the site it pairs as, and the device token. The token lives in the
/// Keychain (this device only, after the first unlock); the Mac keeps only its SHA-256, so Revoke or turning Phone off
/// there makes this copy worthless at once.
struct PairedMac: Codable, Equatable, Sendable {
    var mac: String
    var site: String
    var token: String
    var deviceId: String
    var deviceName: String
    var pairedAt: Date
}

protocol MacStore: AnyObject {
    func load() -> PairedMac?
    func save(_ mac: PairedMac)
    func forget()
}

final class KeychainMacStore: MacStore {
    private let service: String
    private let account = "paired-mac"

    init(service: String = "ai.principia.phone") {
        self.service = service
    }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    func load() -> PairedMac? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        guard let m = try? JSONDecoder().decode(PairedMac.self, from: data),
              PairLink.siteOrigin(m.mac) != nil,
              m.token.range(of: "^[A-Za-z0-9_-]{16,200}$", options: .regularExpression) != nil else { return nil }
        return m
    }

    func save(_ mac: PairedMac) {
        guard let data = try? JSONEncoder().encode(mac) else { return }
        SecItemDelete(query as CFDictionary)
        var q = query
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(q as CFDictionary, nil)
    }

    func forget() {
        SecItemDelete(query as CFDictionary)
    }
}

/// Tests and previews.
final class MemoryMacStore: MacStore {
    var value: PairedMac?
    init(_ value: PairedMac? = nil) { self.value = value }
    func load() -> PairedMac? { value }
    func save(_ mac: PairedMac) { value = mac }
    func forget() { value = nil }
}
