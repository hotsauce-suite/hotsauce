import Foundation

/// The Today page's weather in the app's window (docs/PLAN-weather-place.md W1, W2). WebKit on macOS
/// turns `navigator.geolocation` down in an app's web view without asking, so the page asks the
/// app instead: `webkit.messageHandlers.hearthLocation.postMessage('position')`. The app answers
/// with CoreLocation, which shows macOS's own prompt the first time.
public enum LocationBridge {
    /// The script message handler the page posts to.
    public static let handlerName = "hearthLocation"
    /// System Settings → Privacy & Security → Location Services.
    public static let settingsURL = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices")!
    /// How long to wait for a position before answering "unavailable".
    public static let timeout: TimeInterval = 20

    /// What macOS says about the app's location access.
    public enum Access: Equatable, Sendable {
        case notDetermined
        case allowed
        case denied
        /// Location Services is off for the whole Mac.
        case servicesOff
    }

    /// What the app does next for a request.
    public enum Step: Equatable, Sendable {
        /// Show macOS's prompt, then decide again.
        case ask
        /// Find the position.
        case locate
        /// Answer "denied" and open System Settings, where the member can turn it on.
        case refuseAndOpenSettings
    }

    public static func step(for access: Access) -> Step {
        switch access {
        case .notDetermined: return .ask
        case .allowed: return .locate
        case .denied, .servicesOff: return .refuseAndOpenSettings
        }
    }

    /// Strict: only the exact string 'position' is a request.
    public static func isRequest(_ body: Any) -> Bool {
        (body as? String) == "position"
    }

    /// The answer: rounded to 2 decimals (about 1 km) before it leaves the app.
    public static func position(latitude: Double, longitude: Double) -> [String: Any] {
        let round = { (n: Double) in (n * 100).rounded() / 100 }
        return ["lat": round(latitude), "lon": round(longitude)]
    }

    public enum Failure: String, Sendable { case denied, unavailable }

    public static func failure(_ reason: Failure) -> [String: Any] {
        ["error": reason.rawValue]
    }
}
