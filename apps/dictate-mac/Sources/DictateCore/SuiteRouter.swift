import Foundation

/// Which URLs the app's window shows itself and which go to the default browser, and how deep
/// links and rail shortcuts become URLs on the server.
public struct SuiteRouter: Sendable {
    public enum Decision: Equatable, Sendable {
        /// Let the web view load it.
        case allow
        /// Cancel; nothing else happens.
        case cancel
        /// Cancel, and open it in the default browser (or the mail app).
        case openExternally
        /// A new window asked for a page of the suite: load it in the main window instead.
        case loadInWindow(URL)
        /// One of the app's own links (`hearth-dictate://connect`, a deep link): the app handles
        /// it, with its own checks, instead of macOS.
        case handleInApp(URL)
    }

    /// The suite's origin, e.g. https://office.example.com.
    public let server: URL

    public init(server: URL) {
        self.server = server
    }

    /// The same origin as the server.
    public func isSuite(_ url: URL) -> Bool {
        url.scheme?.lowercased() == server.scheme?.lowercased()
            && url.host?.lowercased() == server.host?.lowercased()
            && effectivePort(url) == effectivePort(server)
    }

    /// Sign-in pages that must stay in the window, so the session lands in its cookie store:
    /// Clerk (its Frontend API on the server's domain, or a development instance) and Google.
    public func isSignIn(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https", let host = url.host?.lowercased() else { return false }
        if host == "accounts.google.com" || host.hasSuffix(".clerk.accounts.dev") || host == "clerk.com" || host.hasSuffix(".clerk.com") {
            return true
        }
        guard let serverHost = server.host?.lowercased() else { return false }
        return host == "clerk.\(serverHost)" || host == "accounts.\(serverHost)"
    }

    /// - Parameters:
    ///   - from: the page the window is on now (nil before the first load).
    ///   - isMainFrame: the navigation replaces the page, rather than an iframe's.
    ///   - userClicked: a link the member clicked (not a redirect or a script).
    ///   - newWindow: `target=_blank` or `window.open` (WebKit only allows those on a click).
    public func decide(_ url: URL, from: URL?, isMainFrame: Bool, userClicked: Bool, newWindow: Bool) -> Decision {
        let scheme = url.scheme?.lowercased() ?? ""
        // The app's own links come back to it, whoever opens them; it asks before connecting.
        if scheme == "hearth-dictate" || scheme == Brand.urlScheme.lowercased() { return .handleInApp(url) }
        if ["about", "blob", "data"].contains(scheme) { return newWindow ? .cancel : .allow }
        // Mail and phone links go to their apps on a click; no other scheme leaves the window
        // (file:, other apps' schemes), so no page can open things on the Mac.
        if scheme == "mailto" || scheme == "tel" { return userClicked || newWindow ? .openExternally : .cancel }
        guard scheme == "http" || scheme == "https" else { return .cancel }
        if newWindow { return isSuite(url) || isSignIn(url) ? .loadInWindow(url) : .openExternally }
        if !isMainFrame || isSuite(url) || isSignIn(url) { return .allow }
        // Elsewhere: only as a hop of a sign-in already under way (Google passes through hosts
        // that can't be listed). Anything else, clicked or not, goes to the browser, which shows
        // its address, so no other site can pose as the app.
        if !userClicked, let from, isSignIn(from) { return .allow }
        return .openExternally
    }

    /// The suite URL for a path like `/meetings/start?event=x`; nil for anything that isn't a
    /// path on this server (a full URL, `//host`, or a path with a scheme).
    public func url(forPath path: String) -> URL? {
        guard path.hasPrefix("/"), !path.hasPrefix("//"), !path.contains("\\"), !Self.isAPIPath(path),
              let components = URLComponents(string: path),
              components.scheme == nil, components.host == nil
        else { return nil }
        guard var full = URLComponents(url: server, resolvingAgainstBaseURL: false) else { return nil }
        full.percentEncodedPath = components.percentEncodedPath
        full.percentEncodedQuery = components.percentEncodedQuery
        full.percentEncodedFragment = components.percentEncodedFragment
        return full.url
    }

    /// The server's API, which links and shortcuts never open: a page is fine, a GET of
    /// `/api/…` with the member's credentials isn't.
    static func isAPIPath(_ path: String) -> Bool {
        let lower = path.lowercased()
        return lower == "/api" || lower.hasPrefix("/api/") || lower.hasPrefix("/api?") || lower.hasPrefix("/mcp") || lower.hasPrefix("/ws/")
    }

    /// The path a deep link opens: `hearth://meetings/x?y` → `/meetings/x?y`, and
    /// `hearth-dictate://open?path=/meetings/x`. Nil for other links (`hearth-dictate://connect`).
    public static func deepLinkPath(_ url: URL, scheme: String = Brand.urlScheme) -> String? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let linkScheme = components.scheme?.lowercased()
        else { return nil }
        if linkScheme == "hearth-dictate" {
            guard components.host?.lowercased() == "open" else { return nil }
            let path = components.queryItems?.first(where: { $0.name == "path" })?.value ?? "/"
            return path.hasPrefix("/") && !path.hasPrefix("//") ? path : nil
        }
        guard linkScheme == scheme.lowercased() else { return nil }
        // hearth://meetings/x parses "meetings" as the host; hearth:///meetings/x has none.
        var path = "/" + (components.host ?? "") + components.percentEncodedPath
        while path.hasPrefix("//") { path.removeFirst() }
        if let query = components.percentEncodedQuery { path += "?" + query }
        if let fragment = components.percentEncodedFragment { path += "#" + fragment }
        return path
    }

    private func effectivePort(_ url: URL) -> Int? {
        url.port ?? (url.scheme?.lowercased() == "https" ? 443 : url.scheme?.lowercased() == "http" ? 80 : nil)
    }
}

/// A file name in a folder that isn't taken yet: `clip.mp4`, then `clip 2.mp4`, `clip 3.mp4`…
public enum DownloadName {
    public static func unique(_ suggested: String, in folder: URL, exists: (URL) -> Bool = { FileManager.default.fileExists(atPath: $0.path) }) -> URL {
        // A server's name could carry a path; only its last part is a file name.
        var name = (suggested as NSString).lastPathComponent.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty || name == "." || name == ".." || name == "/" { name = "download" }
        let candidate = folder.appendingPathComponent(name)
        guard exists(candidate) else { return candidate }
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var n = 2
        while true {
            let next = folder.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
            if !exists(next) { return next }
            n += 1
        }
    }
}
