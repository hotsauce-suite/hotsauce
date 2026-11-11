import Foundation

/// `hearth-dictate://connect?token=hdt_…&server=https://office.example.com`, from the Dictate page.
public struct ConnectLink: Equatable, Sendable {
    public let token: String
    public let server: URL

    public static let defaultServer = URL(string: "https://office.example.com")!

    /// Parses a link or a pasted connection code (the same link, maybe with whitespace around it).
    /// Refuses anything but a well-formed device token and an https server (http only for
    /// localhost, for development).
    public static func parse(_ text: String) -> ConnectLink? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed),
              components.scheme?.lowercased() == "hearth-dictate",
              components.host?.lowercased() == "connect"
        else { return nil }
        let items = components.queryItems ?? []
        guard let token = items.first(where: { $0.name == "token" })?.value,
              isDeviceToken(token)
        else { return nil }
        let serverText = items.first(where: { $0.name == "server" })?.value ?? defaultServer.absoluteString
        guard let server = normalizedServer(serverText) else { return nil }
        return ConnectLink(token: token, server: server)
    }

    public static func isDeviceToken(_ token: String) -> Bool {
        token.range(of: #"^hdt_[A-Za-z0-9_-]{20,128}$"#, options: .regularExpression) != nil
    }

    /// The server's origin (scheme, host, port), or nil if it isn't one Hearth Dictate will talk to.
    public static func normalizedServer(_ text: String) -> URL? {
        guard let url = URL(string: text.trimmingCharacters(in: .whitespaces)),
              let scheme = url.scheme?.lowercased(),
              let host = url.host?.lowercased(), !host.isEmpty,
              url.user == nil, url.password == nil
        else { return nil }
        let local = host == "localhost" || host == "127.0.0.1"
        guard scheme == "https" || (scheme == "http" && local) else { return nil }
        var origin = URLComponents()
        origin.scheme = scheme
        origin.host = host
        origin.port = url.port
        return origin.url
    }

    /// Whether connecting needs a second look: anything but the server this app was built for.
    public var isUnfamiliarServer: Bool {
        server != Self.defaultServer
    }
}
