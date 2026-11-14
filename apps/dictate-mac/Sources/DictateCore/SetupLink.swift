import Foundation

/// `hearth://setup?server=<origin>`: a workspace's download page links here so the setup window
/// opens with its address filled in. It only fills the field: Continue still checks the address
/// (`Workspace.check`) before anything is saved (docs/PLAN-mac-onboarding.md R4).
public enum SetupLink {
    /// The workspace a setup link names, or nil for any other link.
    public static func server(from url: URL, scheme: String = Brand.urlScheme) -> URL? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == scheme.lowercased()
        else { return nil }
        // hearth://setup parses "setup" as the host; hearth:///setup has it as the path.
        var target = ((components.host ?? "") + components.path).lowercased()
        while target.hasPrefix("/") { target.removeFirst() }
        while target.hasSuffix("/") { target.removeLast() }
        guard target == "setup",
              let text = components.queryItems?.first(where: { $0.name == "server" })?.value
        else { return nil }
        return Workspace.origin(fromInput: text)
    }

    /// The link for a server, as its download page offers it.
    public static func url(server: URL, scheme: String = Brand.urlScheme) -> URL? {
        guard let origin = ConnectLink.normalizedServer(server.absoluteString) else { return nil }
        var components = URLComponents()
        components.scheme = scheme
        components.host = "setup"
        components.queryItems = [URLQueryItem(name: "server", value: origin.absoluteString)]
        return components.url
    }
}
