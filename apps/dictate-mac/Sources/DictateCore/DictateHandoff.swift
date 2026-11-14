import Foundation

/// Signing in also connects Dictate (docs/PLAN-mac-onboarding.md R8). Right after the window's
/// browser sign-in, `/desktop/finish` asks the app over `hearthDictateConnect` whether this Mac
/// needs a Dictate connection; if so the page, now signed in, creates a device token through the
/// API and hands it to the app over the same bridge. The token never appears in a URL, and the
/// bridge only answers on the suite's finish page for a short while after the app handed over a
/// sign-in ticket, once.
public enum DictateHandoff {
    public static let handlerName = "hearthDictateConnect"
    /// How long after the ticket was taken the finish page may connect Dictate.
    public static let window: TimeInterval = 120

    public enum Request: Equatable, Sendable {
        /// Does this Mac need a connection, and what to call the device?
        case status
        /// Save this device token as the Mac's connection.
        case connect(token: String)
    }

    /// Strict: `{type: 'status'}` or `{type: 'connect', token: 'hdt_…'}` with a well-formed token.
    public static func request(_ body: Any) -> Request? {
        guard let object = body as? [String: Any], let type = object["type"] as? String else { return nil }
        switch type {
        case "status":
            return object.count == 1 ? .status : nil
        case "connect":
            guard object.count == 2, let token = object["token"] as? String, ConnectLink.isDeviceToken(token) else { return nil }
            return .connect(token: token)
        default:
            return nil
        }
    }

    /// Whether the handoff the app opened at `openedAt` still takes requests at `now`.
    public static func isOpen(openedAt: Date?, now: Date) -> Bool {
        guard let openedAt else { return false }
        let age = now.timeIntervalSince(openedAt)
        return age >= 0 && age <= window
    }

    /// A Mac connected to this server already needs nothing; one connected elsewhere, or not at
    /// all, gets a connection to the server it just signed in to.
    public static func needed(connection: URL?, server: URL) -> Bool {
        guard let connection else { return true }
        return ConnectLink.normalizedServer(connection.absoluteString) != ConnectLink.normalizedServer(server.absoluteString)
    }

    /// The device's name on the Dictate page: the Mac's own name, kept short and on one line.
    public static func deviceName(_ macName: String?) -> String {
        let flat = (macName ?? "").replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        return flat.isEmpty ? "Mac" : String(flat.prefix(80))
    }
}
