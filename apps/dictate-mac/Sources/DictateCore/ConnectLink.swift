import Foundation

/// `hearth-dictate://connect?token=hdt_…&server=https://team.example.com`, from the Dictate page.
/// The app has no built-in server: one app serves every organization, so the address always comes
/// from the link, the member or the server itself.
public struct ConnectLink: Equatable, Sendable {
    public let token: String
    public let server: URL

    /// Parses a link or a pasted connection code (the same link, maybe with whitespace around it).
    /// Refuses anything but a well-formed device token and an https server (http only for
    /// localhost, for development). A code without a server is for `workspace`, the one this Mac
    /// already uses; with none, it's refused.
    public static func parse(_ text: String, workspace: URL? = nil) -> ConnectLink? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed),
              components.scheme?.lowercased() == "hearth-dictate",
              components.host?.lowercased() == "connect"
        else { return nil }
        let items = components.queryItems ?? []
        guard let token = items.first(where: { $0.name == "token" })?.value,
              isDeviceToken(token)
        else { return nil }
        guard let serverText = items.first(where: { $0.name == "server" })?.value ?? workspace?.absoluteString,
              let server = normalizedServer(serverText)
        else { return nil }
        return ConnectLink(token: token, server: server)
    }

    public static func isDeviceToken(_ token: String) -> Bool {
        token.range(of: #"^hdt_[A-Za-z0-9_-]{20,128}$"#, options: .regularExpression) != nil
    }

    /// The server's origin (scheme, host, port), or nil if it isn't one Hotsauce Dictate will talk to.
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

    /// Whether connecting needs a second look: any server but `workspace`, the one this Mac
    /// already uses. With none yet, every server does.
    public func isUnfamiliar(to workspace: URL?) -> Bool {
        guard let workspace else { return true }
        return server != Self.normalizedServer(workspace.absoluteString)
    }
}
