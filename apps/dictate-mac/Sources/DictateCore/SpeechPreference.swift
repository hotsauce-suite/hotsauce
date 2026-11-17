import Foundation

/// The member's last known Dictate choices (docs/PLAN-dictate-models.md, R8), kept on this Mac
/// so the first key press after a restart already honours them. The server holds the real ones;
/// the app asks it at launch, on connecting, at each key press and after a refusal. A new
/// connection forgets them, and until they are known again a dictation stays on the Mac.
public enum SpeechPreference {
    public struct Known: Equatable, Sendable {
        /// "On this Mac only": the voice never leaves the Mac.
        public var keepOnMac: Bool
        /// The text is sent to be tidied (Cleanup isn't Off, and the server can tidy).
        public var tidy: Bool

        public init(keepOnMac: Bool, tidy: Bool) {
            self.keepOnMac = keepOnMac
            self.tidy = tidy
        }
    }

    static let keepKey = "keepSpeechOnMac"
    static let tidyKey = "tidySpeechKeptOnMac"

    /// Nil until the server has answered for this connection.
    public static func known(_ defaults: UserDefaults = .standard) -> Known? {
        guard defaults.object(forKey: keepKey) != nil else { return nil }
        return Known(keepOnMac: defaults.bool(forKey: keepKey), tidy: defaults.object(forKey: tidyKey) as? Bool ?? true)
    }

    public static func set(_ known: Known, in defaults: UserDefaults = .standard) {
        defaults.set(known.keepOnMac, forKey: keepKey)
        defaults.set(known.tidy, forKey: tidyKey)
    }

    /// Another account or server: its choices aren't known yet.
    public static func forget(_ defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: keepKey)
        defaults.removeObject(forKey: tidyKey)
    }
}
