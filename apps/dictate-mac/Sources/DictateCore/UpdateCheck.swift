import Foundation

/// Hotsauce → Check for Updates… (docs/PLAN-mac-check-for-updates.md): what a check the person
/// asked for found, and what the app says about it.
public enum UpdateCheck {
    public enum Outcome: Equatable, Sendable {
        /// No workspace yet, so no server to ask.
        case noWorkspace
        /// The server didn't answer, or didn't say which Mac app is newest.
        case unreachable
        /// Nothing newer than this copy.
        case upToDate(version: String?, build: String?)
        /// A newer build, and where the updater stands with it.
        case newer(UpdateState)
    }

    /// What the reply's default button does.
    public enum Action: Equatable, Sendable {
        case none
        case restart
        case download
    }

    public struct Message: Equatable, Sendable {
        public let title: String
        public let text: String
        public let button: String
        /// The second button ("Later"), or nil for a single OK.
        public let cancel: String?
        public let action: Action
    }

    /// "0.62.4 (build 140)", "0.62.4", or nil.
    public static func versionText(_ version: String?, build: String?) -> String? {
        guard let version = AppVersion.valid(version) else { return nil }
        return AppVersion.validBuild(build).map { "\(version) (build \($0))" } ?? version
    }

    /// The reply for `outcome`; `downloading` is the one that waits, and asks again once ready.
    public static func message(_ outcome: Outcome, name: String = Brand.name) -> Message {
        switch outcome {
        case .noWorkspace:
            return Message(
                title: "Connect to a workspace first",
                text: "\(name) checks for updates with your workspace. Choose one in the setup window, then check again.",
                button: "OK", cancel: nil, action: .none)
        case .unreachable:
            return Message(
                title: "Couldn’t check for updates",
                text: "Your workspace didn’t answer. Check your connection and try again.",
                button: "OK", cancel: nil, action: .none)
        case .upToDate(let version, let build):
            let which = versionText(version, build: build).map { "\(name) \($0)" } ?? "This copy of \(name)"
            return Message(
                title: "You’re up to date",
                text: "\(which) is the newest version.",
                button: "OK", cancel: nil, action: .none)
        case .newer(.ready(let v)):
            return Message(
                title: "\(name) \(v) is ready",
                text: "Restart to update. \(name) reopens in a few seconds, with its permissions kept.",
                button: "Restart Now", cancel: "Later", action: .restart)
        case .newer(.downloading(let v)):
            return Message(
                title: "Downloading \(name) \(v)…",
                text: "It’s getting ready in the background. You’ll be asked to restart when it’s done.",
                button: "OK", cancel: nil, action: .none)
        case .newer(.available(let v)):
            return Message(
                title: "\(name) \(v) is out",
                text: "This copy can’t update itself (it may be running from the disk image, or from a folder it can’t change). Download the new version and drag it into Applications.",
                button: "Download", cancel: "Later", action: .download)
        case .newer(.none):
            return message(.upToDate(version: nil, build: nil), name: name)
        }
    }
}

/// The About panel's extras.
public enum AboutInfo {
    /// Where the app's source lives; the About panel links to it.
    public static let sourceURL = URL(string: "https://github.com/hotsauce-suite/hotsauce")!
    /// The link's text: the address without its scheme.
    public static var sourceLabel: String { "github.com" + sourceURL.path }
}
