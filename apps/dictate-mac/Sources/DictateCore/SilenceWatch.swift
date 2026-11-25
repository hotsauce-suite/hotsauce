import Foundation

/// Says, once, that the mic hears nothing (docs/PLAN-dictate-send-and-sounds.md, R13): when every
/// level in the first `window` seconds of a dictation stays below a whisper.
public struct SilenceWatch: Equatable, Sendable {
    public static let window: TimeInterval = 2.5
    /// The recorder's level (0…1) for room noise from a working mic is well above this.
    public static let silentLevel: Float = 0.002

    private let startedAt: TimeInterval
    private var loudest: Float = 0
    private var done = false

    public init(startedAt: TimeInterval) {
        self.startedAt = startedAt
    }

    /// Feed each level as it arrives; true exactly once, when the mic has been silent too long.
    public mutating func push(level: Float, at time: TimeInterval) -> Bool {
        guard !done else { return false }
        loudest = max(loudest, level)
        if loudest >= Self.silentLevel {
            done = true
            return false
        }
        if time - startedAt >= Self.window {
            done = true
            return true
        }
        return false
    }
}

/// When to say the connection is slow (R13): the stream isn't ready this long into a dictation,
/// or the words take this long after it ends.
public enum SlowConnection {
    public static let streamNotReadyAfter: TimeInterval = 3
    public static let answerAfter: TimeInterval = 4
}
