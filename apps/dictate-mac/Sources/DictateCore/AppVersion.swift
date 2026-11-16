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

    /// `mac/<version>` for the header, or nil when the version isn't a plain one.
    public static func headerValue(version: String?) -> String? {
        valid(version).map { "mac/\($0)" }
    }

    /// Adds the header to a request when this build knows its version.
    public static func tag(_ request: inout URLRequest, version: String? = current) {
        if let value = headerValue(version: version) { request.setValue(value, forHTTPHeaderField: headerName) }
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

    /// The newest version a server's `/downloads/mac-app.json` names, or nil.
    public static func latest(fromJSON data: Data) -> String? {
        struct Info: Decodable { let version: String }
        return valid((try? JSONDecoder().decode(Info.self, from: data))?.version)
    }

    /// The version to offer, when `latest` is newer than `installed`; else nil.
    public static func update(installed: String?, latest: String?) -> String? {
        guard let installed = valid(installed), let latest = valid(latest) else { return nil }
        return compare(installed, latest) == .orderedAscending ? latest : nil
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
        let digits = build.flatMap { $0.range(of: #"^\d{1,9}$"#, options: .regularExpression) != nil ? $0 : nil }
        let buildPart = digits.map { ", build: '\($0)'" } ?? ""
        return "window.hotsauceMacApp = Object.freeze({ version: '\(version)'\(buildPart) });"
    }
}
