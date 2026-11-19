import Foundation

/// When the floating preview after a capture goes away (docs/PLAN-screenshots.md R10): after 7
/// seconds, paused while the pointer is over it or the shot is being dragged out, never once
/// pinned. Times come in as arguments, as in `HotkeyStateMachine`, so it is tested without a clock.
public struct ScreenshotPreviewTimer: Equatable, Sendable {
    /// How long the preview stays when left alone.
    public static let lifetime: TimeInterval = 7
    /// After the pointer leaves (or a drag ends), at least this long, so it doesn't vanish at once.
    public static let afterHover: TimeInterval = 2

    public private(set) var isPinned = false
    public private(set) var isHovered = false
    public private(set) var isDragging = false
    /// Seconds left on the countdown when it last paused (or started).
    private var remaining: TimeInterval
    /// When the countdown last started running; nil while paused.
    private var runningSince: TimeInterval?

    public init(shownAt time: TimeInterval) {
        remaining = Self.lifetime
        runningSince = time
    }

    public var isPaused: Bool { runningSince == nil }

    /// When it should close, or nil while paused or pinned.
    public var closesAt: TimeInterval? {
        guard !isPinned, let runningSince else { return nil }
        return runningSince + remaining
    }

    public func shouldClose(at time: TimeInterval) -> Bool {
        guard let closesAt else { return false }
        return time >= closesAt
    }

    public mutating func hover(_ inside: Bool, at time: TimeInterval) {
        isHovered = inside
        update(at: time)
    }

    public mutating func dragging(_ active: Bool, at time: TimeInterval) {
        isDragging = active
        update(at: time)
    }

    /// Pin keeps it until Close; pressing Pin again lets it count down again.
    public mutating func togglePin(at time: TimeInterval) {
        // Pinning freezes the countdown where it was; while pinned it doesn't run.
        if !isPinned, let runningSince {
            remaining = max(0, remaining - (time - runningSince))
            self.runningSince = time
        }
        isPinned.toggle()
        if !isPinned {
            remaining = max(remaining, Self.afterHover)
            if runningSince != nil { runningSince = time }
        }
    }

    private mutating func update(at time: TimeInterval) {
        let held = isHovered || isDragging
        if held, let runningSince {
            if !isPinned { remaining = max(0, remaining - (time - runningSince)) }
            self.runningSince = nil
        } else if !held, runningSince == nil {
            remaining = max(remaining, Self.afterHover)
            runningSince = time
        }
    }
}
