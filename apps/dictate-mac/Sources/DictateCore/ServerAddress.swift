import Foundation

/// Which server the app's window opens, and how it follows a server that moved to a new address.
public enum ServerAddress {
    /// The window's server: the one in Settings, else the one this Mac is connected to, else the
    /// built-in default. One app serves every organization, so the connection is usually the
    /// only place the app learns its organization's address.
    public static func windowServer(setting: URL?, connection: URL?) -> URL {
        setting ?? connection ?? ConnectLink.defaultServer
    }

    /// The address a server says it lives at: `publicUrl` in its `/api/health`, as an origin the
    /// app will talk to. Nil when the server doesn't say (an older server) or the answer isn't one.
    public static func reportedOrigin(healthJSON data: Data) -> URL? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let text = object["publicUrl"] as? String
        else { return nil }
        return ConnectLink.normalizedServer(text)
    }

    /// Whether the window leaving `current` for `target` is the server moving: the target is on
    /// the address the current server itself reports, and that address is a different one.
    public static func isMove(from current: URL, to target: URL, reported: URL?) -> Bool {
        guard let reported, let targetOrigin = ConnectLink.normalizedServer(target.absoluteString),
              let currentOrigin = ConnectLink.normalizedServer(current.absoluteString)
        else { return false }
        // A server left on the default PUBLIC_URL (localhost) never pulls a real one onto this Mac.
        if isLocal(reported), !isLocal(currentOrigin) { return false }
        return targetOrigin == reported && reported != currentOrigin
    }

    private static func isLocal(_ url: URL) -> Bool {
        let host = url.host?.lowercased() ?? ""
        return host == "localhost" || host == "127.0.0.1"
    }

    /// The `/api/health` URL of a server.
    public static func healthURL(server: URL) -> URL? {
        guard var components = URLComponents(url: server, resolvingAgainstBaseURL: false) else { return nil }
        components.path = "/api/health"
        components.query = nil
        components.fragment = nil
        return components.url
    }
}

/// How long the window waits before loading the suite again after it couldn't reach it: a server
/// restarting for an update is back within seconds, a Mac waking up or logging in may need longer.
public enum RetryBackoff {
    public static func delay(afterFailures failures: Int) -> TimeInterval {
        let steps: [TimeInterval] = [2, 4, 8, 15]
        guard failures > 0 else { return steps[0] }
        return failures <= steps.count ? steps[failures - 1] : 30
    }
}
