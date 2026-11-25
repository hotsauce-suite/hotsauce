import Foundation

/// Other apps' sound while dictating (docs/PLAN-dictate-send-and-sounds.md, R12): left alone,
/// lowered to 30% of the volume, or muted. A choice of each Mac.
public enum QuietAudio: String, CaseIterable, Codable, Sendable {
    case off
    case lower
    case mute

    public static let key = "quietAudio"
    /// How far Lower takes the volume.
    public static let lowerTo: Float = 0.3

    /// The volume to set while dictating, from the volume now; nil leaves it.
    public func quietVolume(from volume: Float) -> Float? {
        switch self {
        case .off: nil
        case .lower: volume * Self.lowerTo
        case .mute: 0
        }
    }
}

/// What was changed for a dictation, so it can be put back, and only if the member hasn't moved
/// the volume meanwhile.
public struct QuietedVolume: Codable, Equatable, Sendable {
    public var original: Float
    public var quiet: Float

    public init(original: Float, quiet: Float) {
        self.original = original
        self.quiet = quiet
    }

    /// The volume to put back, given the volume now; nil when the member changed it themselves.
    public func restore(current: Float) -> Float? {
        abs(current - quiet) < 0.02 ? original : nil
    }

    static let key = "quietedVolume"

    /// Kept until the volume is back, so a crash mid-dictation is put right at the next launch.
    public static func saved(_ defaults: UserDefaults = .standard) -> QuietedVolume? {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(QuietedVolume.self, from: $0) }
    }

    public func save(_ defaults: UserDefaults = .standard) {
        if let data = try? JSONEncoder().encode(self) { defaults.set(data, forKey: Self.key) }
    }

    public static func clear(_ defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: key)
    }
}
