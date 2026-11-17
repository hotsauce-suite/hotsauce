import Foundation

/// The member's last known "On this Mac only" choice (docs/PLAN-dictate-models.md, R8), kept on
/// this Mac so the first key press after a restart already honours it. The server holds the real
/// choice; the app asks it at launch, at each key press, and after a refusal.
public enum SpeechPreference {
    static let key = "keepSpeechOnMac"

    public static func keepsOnMac(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: key)
    }

    public static func set(_ keep: Bool, in defaults: UserDefaults = .standard) {
        defaults.set(keep, forKey: key)
    }
}
