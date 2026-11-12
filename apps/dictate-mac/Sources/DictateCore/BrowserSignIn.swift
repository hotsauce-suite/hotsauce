import Foundation
import Security

/// Signing the app's window in through the member's browser (ARCHITECTURE §9.4.1): Google won't
/// sign in inside an app's web view, and the browser is usually signed in already. The app opens
/// `<server>/desktop/connect?state=<nonce>`; after the member confirms there, the browser opens
/// `<scheme>://auth/callback?state=…&ticket=…`; the app checks the state is the one it sent
/// (recently, once) and opens `<server>/desktop/finish` in its window, which asks the app for the
/// ticket over a script bridge: the ticket is never in a URL, so no link can supply one.
public struct BrowserSignIn: Sendable {
    /// How long a started sign-in waits for the browser.
    public static let timeout: TimeInterval = 10 * 60

    public let state: String
    public let started: Date

    public init(state: String = BrowserSignIn.randomState(), started: Date = Date()) {
        self.state = state
        self.started = started
    }

    /// 32 random bytes, base64url: what /desktop/connect accepts (32–128 URL-safe characters).
    public static func randomState() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// The browser page that confirms and hands back a ticket.
    public func connectURL(server: URL) -> URL? {
        guard var components = URLComponents(url: server, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/desktop/connect"
        components.queryItems = [URLQueryItem(name: "state", value: state)]
        return components.url
    }

    /// The ticket from a callback link, if the link is a callback for this sign-in, in time.
    public func ticket(from url: URL, now: Date = Date(), scheme: String = Brand.urlScheme) -> String? {
        guard let callback = Self.callback(url, scheme: scheme),
              callback.state == state,
              now.timeIntervalSince(started) >= 0, now.timeIntervalSince(started) <= Self.timeout
        else { return nil }
        return callback.ticket
    }

    /// `<scheme>://auth/callback?state=…&ticket=…`, whoever sent it; nil for any other link.
    public static func callback(_ url: URL, scheme: String = Brand.urlScheme) -> (state: String, ticket: String)? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == scheme.lowercased(),
              components.host?.lowercased() == "auth", components.path == "/callback"
        else { return nil }
        let items = components.queryItems ?? []
        guard let state = items.first(where: { $0.name == "state" })?.value,
              let ticket = items.first(where: { $0.name == "ticket" })?.value,
              !ticket.isEmpty, ticket.count <= 4096,
              ticket.range(of: #"^[A-Za-z0-9._:@+-]+$"#, options: .regularExpression) != nil
        else { return nil }
        return (state, ticket)
    }

    /// The page in the app's window that redeems the ticket the app hands it.
    public static func finishURL(server: URL) -> URL? {
        guard var components = URLComponents(url: server, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/desktop/finish"
        return components.url
    }

    /// How long a received ticket waits for the finish page to take it (Clerk's lasts 60 s).
    public static let ticketHandoff: TimeInterval = 60
}
