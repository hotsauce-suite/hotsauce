import DictateCore
import Foundation
import Security

/// This Mac's connection to Hearth: the device token and its server, kept together so nothing can
/// point the token at another server without going through Connect (and its prompt).
///
/// Stored in ~/Library/Application Support/HearthDictate/connection.json (0600, in a 0700 folder),
/// not the Keychain: a self-signed app's Keychain items are tied to each build's code hash, so
/// every update asked for the login password. The token is scoped to dictation and word lists and
/// revocable on your workspace’s /dictate page, so a user-only file is a fair trade for silent updates.
enum ConnectionStore {
    struct Connection: Codable, Equatable {
        let token: String
        let server: URL
        /// Whose Hearth it is, for the windows. Missing in connections saved before 0.1.1.
        var account: String? = nil
    }

    static var fileURL: URL {
        HistoryStore.defaultURL.deletingLastPathComponent().appendingPathComponent("connection.json")
    }

    /// Read once and kept in memory; the app checks it every few seconds.
    private static var cached: Connection??

    static func connection() -> Connection? {
        if let cached { return cached }
        let loaded = PrivateFile.read(fileURL).flatMap { try? JSONDecoder().decode(Connection.self, from: $0) }
            ?? migrateFromKeychain()
        cached = .some(loaded)
        return loaded
    }

    @discardableResult
    static func setConnection(_ connection: Connection) -> Bool {
        guard let data = try? JSONEncoder().encode(connection), PrivateFile.write(data, to: fileURL) else { return false }
        cached = .some(connection)
        // An old item a failed migration left behind isn't needed once the file exists.
        deleteLegacyKeychainItem()
        return true
    }

    static func delete() {
        cached = .some(nil)
        PrivateFile.delete(fileURL)
        deleteLegacyKeychainItem()
    }

    // MARK: The Keychain item 0.1.x used

    private static let legacyQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "dev.hotsauce.dictate",
        kSecAttrAccount as String: "connection",
    ]

    /// Moves a connection saved by an earlier version into the file, without ever showing the
    /// Keychain's password prompt: if macOS would ask, the member connects again instead.
    private static func migrateFromKeychain() -> Connection? {
        var query = legacyQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail
        var item: CFTypeRef?
        let status = withoutKeychainPrompts { SecItemCopyMatching(query as CFDictionary, &item) }
        guard status == errSecSuccess, let data = item as? Data,
              let connection = try? JSONDecoder().decode(Connection.self, from: data)
        else { return nil }
        setConnection(connection)
        return connection
    }

    private static func deleteLegacyKeychainItem() {
        _ = withoutKeychainPrompts { SecItemDelete(legacyQuery as CFDictionary) }
    }

    /// The file-based keychain's "wants to use your confidential information" dialog ignores
    /// kSecUseAuthenticationUI; turning interaction off (process-wide, so always turned back on)
    /// is what keeps it from appearing or blocking. Nothing else in the app uses the Keychain.
    private static func withoutKeychainPrompts(_ body: () -> OSStatus) -> OSStatus {
        SecKeychainSetUserInteractionAllowed(false)
        defer { SecKeychainSetUserInteractionAllowed(true) }
        return body()
    }
}
