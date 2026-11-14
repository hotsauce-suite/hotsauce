import Foundation

/// Settings → Notifications in the app's window. WebKit gives an app's web view no Notification
/// API, so the page asks the app instead: `webkit.messageHandlers.hearthNotifications.postMessage`
/// with 'state' (what macOS allows now) or 'open' (ask macOS the first time, else open the app's
/// page in System Settings → Notifications), and gets back the state.
public enum NotificationsBridge {
    /// The script message handler the page posts to.
    public static let handlerName = "hearthNotifications"

    public enum Request: String, Sendable {
        case state
        case open
    }

    /// Strict: only the exact strings 'state' and 'open'.
    public static func request(_ body: Any) -> Request? {
        (body as? String).flatMap(Request.init(rawValue:))
    }

    /// What macOS says about the app's notifications, as the page reads it.
    public enum State: String, Sendable {
        /// Allowed (or allowed quietly).
        case on
        /// Turned off for the app in System Settings.
        case off
        /// Never asked: the first 'open' shows macOS's prompt.
        case undecided
    }

    /// What 'open' does for a state.
    public enum Step: Equatable, Sendable {
        case ask
        case openSettings
    }

    public static func step(for state: State) -> Step {
        state == .undecided ? .ask : .openSettings
    }
}
