import Foundation

/// Which Mac app this is, told to the server and the page, and whether a newer one is out
/// (docs/PLAN-mac-version-and-whats-new.md, M3, M4, M7). The app doesn't update itself: the
/// server publishes the newest build's version at `/downloads/mac-app.json`.
public enum AppVersion {
    /// Sent with every device-token request, so Settings can show each Mac's version.
    public static let headerName = "Hotsauce-App"

    /// This build's version, from Info.plist; nil when run without one (`swift run`, tests).
    public static var current: String? { valid(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) }
    public static var build: String? { Bundle.main.infoDictionary?["CFBundleVersion"] as? String }

    /// A plain dotted version like 0.26.0, or nil.
    public static func valid(_ version: String?) -> String? {
        guard let v = version?.trimmingCharacters(in: .whitespaces),
              v.range(of: #"^\d{1,4}\.\d{1,4}\.\d{1,4}$"#, options: .regularExpression) != nil else { return nil }
        return v
    }

    /// A build number of digits only, or nil.
    public static func validBuild(_ build: String?) -> String? {
        guard let b = build, b.range(of: #"^\d{1,9}$"#, options: .regularExpression) != nil else { return nil }
        return b
    }

    /// `mac/<version>`, or `mac/<version>+<build>` (a Mac-only change makes a new build of the same
    /// release); nil when the version isn't a plain one.
    public static func headerValue(version: String?, build: String? = nil) -> String? {
        guard let v = valid(version) else { return nil }
        return validBuild(build).map { "mac/\(v)+\($0)" } ?? "mac/\(v)"
    }

    /// Adds the header to a request when this build knows its version.
    public static func tag(_ request: inout URLRequest, version: String? = current, build: String? = AppVersion.build) {
        if let value = headerValue(version: version, build: build) { request.setValue(value, forHTTPHeaderField: headerName) }
    }

    /// Orders two dotted versions number by number (0.9.0 < 0.10.0).
    public static func compare(_ a: String, _ b: String) -> ComparisonResult {
        let x = a.split(separator: ".").map { Int($0) ?? 0 }
        let y = b.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(x.count, y.count) {
            let l = i < x.count ? x[i] : 0
            let r = i < y.count ? y[i] : 0
            if l != r { return l < r ? .orderedAscending : .orderedDescending }
        }
        return .orderedSame
    }

    /// The newest build a server offers.
    public struct Latest: Equatable, Sendable {
        public let version: String
        public let build: String?
        public init(version: String, build: String? = nil) {
            self.version = version
            self.build = build
        }
    }

    /// The newest build a server's `/downloads/mac-app.json` names, or nil.
    public static func latest(fromJSON data: Data) -> Latest? {
        struct Info: Decodable { let version: String; let build: String? }
        guard let info = try? JSONDecoder().decode(Info.self, from: data), let v = valid(info.version) else { return nil }
        return Latest(version: v, build: validBuild(info.build))
    }

    /// The version to offer when `latest` is newer than what's installed (a higher version, or the
    /// same version with a higher build); else nil.
    public static func update(installed: String?, installedBuild: String? = nil, latest: Latest?) -> String? {
        guard let installed = valid(installed), let latest, let newest = valid(latest.version) else { return nil }
        switch compare(installed, newest) {
        case .orderedAscending: return newest
        case .orderedDescending: return nil
        case .orderedSame:
            guard let mine = validBuild(installedBuild).flatMap(Int.init),
                  let theirs = validBuild(latest.build).flatMap(Int.init), mine < theirs else { return nil }
            return newest
        }
    }

    /// Where the newest build's version is published on a server.
    public static func infoURL(server: URL) -> URL {
        server.appendingPathComponent("downloads/mac-app.json")
    }

    /// The newest build itself.
    public static func downloadURL(server: URL) -> URL {
        server.appendingPathComponent("downloads/\(Brand.name).dmg")
    }

    /// Run in the window before the page's own code, so Settings → Apps can say which version this is.
    public static func pageScript(version: String?, build: String?) -> String? {
        guard let version = valid(version) else { return nil }
        let buildPart = validBuild(build).map { ", build: '\($0)'" } ?? ""
        return "window.hotsauceMacApp = Object.freeze({ version: '\(version)'\(buildPart) });"
    }
}
