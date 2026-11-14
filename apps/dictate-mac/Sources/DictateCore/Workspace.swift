import Foundation

/// The setup window's Workspace step: where this Mac's team's server lives. The member types an
/// address; the app checks that a Hotsauce server answers there before saving it
/// (docs/PLAN-mac-onboarding.md R2, R3).
public enum Workspace {
    /// What the member typed, as a server origin: a bare host (`team.example.com`) or a full URL,
    /// https only (http only for localhost), keeping only scheme, host and port. Nil for anything
    /// else, including a single word, which is never a workspace's address.
    public static func origin(fromInput text: String) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.contains(where: \.isWhitespace) else { return nil }
        // A bare word is a typo, not an address; a full URL may name an internal host (a NAS on the LAN).
        let hasScheme = trimmed.contains("://")
        guard let origin = ConnectLink.normalizedServer(hasScheme ? trimmed : "https://" + trimmed),
              let host = origin.host
        else { return nil }
        guard hasScheme || host.contains(".") || host == "localhost" else { return nil }
        return origin
    }

    /// How the setup window shows an address: `team.example.com` for https (with a port if it has
    /// one), the whole origin for http (localhost), so typing it back gives the same origin.
    public static func displayAddress(_ server: URL) -> String {
        guard server.scheme?.lowercased() == "https", let host = server.host else { return server.absoluteString }
        return server.port.map { "\(host):\($0)" } ?? host
    }

    /// What a Hotsauce server says about itself in `/api/health` (apps/server/src/api/public.ts).
    public struct Info: Equatable, Sendable {
        /// The address that answered.
        public let server: URL
        public let orgName: String?
        public let signInDomain: String?
        /// Where the server says it lives (`publicUrl`), when it says.
        public let reported: URL?
        /// The server hasn't been set up yet: nobody can sign in until it is.
        public let setupRequired: Bool

        /// One line for the setup window: who the workspace is for and how to sign in.
        public var summary: String {
            let host = server.host ?? server.absoluteString
            let name = orgName ?? host
            if setupRequired {
                return "\(name). This workspace hasn’t finished its setup yet; whoever runs it can finish it at \(host)/setup."
            }
            let account = signInDomain.map { "your \($0) Google account" } ?? "your Google account"
            return "\(name). Sign in with \(account)."
        }
    }

    /// The server's own description, or nil when what answered isn't a Hotsauce server: it must
    /// say `ok`, its product name and its sign-in mode.
    public static func info(healthJSON data: Data, server: URL) -> Info? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["ok"] as? Bool == true,
              object["productName"] is String,
              object["authMode"] is String
        else { return nil }
        func text(_ key: String) -> String? {
            (object[key] as? String).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.flatMap { $0.isEmpty ? nil : $0 }
        }
        return Info(
            server: server,
            orgName: text("orgName"),
            signInDomain: text("signInDomain"),
            reported: ServerAddress.reportedOrigin(healthJSON: data),
            setupRequired: object["setupRequired"] as? Bool ?? false
        )
    }

    public enum CheckResult: Equatable, Sendable {
        case found(Info)
        /// Something answered, but not a Hotsauce server (a company website, a typo'd host that exists).
        case notHotsauce
        /// Nothing answered: offline, no such host, a certificate problem. The system's reason.
        case unreachable(String)

        /// What the setup window says when the address doesn't work.
        public func message(for address: URL) -> String? {
            let host = address.host ?? address.absoluteString
            switch self {
            case .found: return nil
            case .notHotsauce: return "\(host) answered, but it isn’t a \(Brand.name) workspace. Check the address with whoever set it up."
            case let .unreachable(reason): return "Couldn’t reach \(host). \(reason)"
            }
        }
    }

    /// GETs a URL; the body and HTTP status. Throws when nothing answers.
    public typealias Fetch = @Sendable (URL) async throws -> (Data, Int)

    /// Checks `server` is a Hotsauce workspace. A server that says it lives elsewhere (`publicUrl`)
    /// is checked there too and the new address is used when it answers, as the window would
    /// follow it anyway; a real server never sends the Mac to localhost.
    public static func check(_ server: URL, fetch: Fetch) async -> CheckResult {
        let first = await checkOnce(server, fetch: fetch)
        guard case let .found(info) = first, let reported = info.reported, reported != server,
              !(ServerAddress.isLocal(reported) && !ServerAddress.isLocal(server))
        else { return first }
        if case let .found(moved) = await checkOnce(reported, fetch: fetch) { return .found(moved) }
        return first
    }

    private static func checkOnce(_ server: URL, fetch: Fetch) async -> CheckResult {
        guard let health = ServerAddress.healthURL(server: server) else { return .notHotsauce }
        do {
            let (data, status) = try await fetch(health)
            guard status == 200, let info = info(healthJSON: data, server: server) else { return .notHotsauce }
            return .found(info)
        } catch {
            return .unreachable(error.localizedDescription)
        }
    }

    /// The real fetch: no cookies or cache, a short timeout, JSON asked for.
    public static let networkFetch: Fetch = { url in
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await URLSession(configuration: .ephemeral).data(for: request)
        return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
    }
}
