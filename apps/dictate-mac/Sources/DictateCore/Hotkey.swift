import Foundation

/// The key held to dictate. Each is a modifier, seen as `flagsChanged` events.
public enum Hotkey: String, CaseIterable, Codable, Sendable {
    case rightOption
    case rightCommand
    case fn

    public var title: String {
        switch self {
        case .rightOption: "Right Option (⌥)"
        case .rightCommand: "Right Command (⌘)"
        case .fn: "Fn / Globe"
        }
    }

    /// For "Hold Right ⌥ to dictate".
    public var shortName: String {
        switch self {
        case .rightOption: "Right ⌥"
        case .rightCommand: "Right ⌘"
        case .fn: "Fn"
        }
    }

    /// The virtual key code macOS reports for the key (kVK_RightOption, kVK_RightCommand, kVK_Function).
    public var keyCode: Int64 {
        switch self {
        case .rightOption: 61
        case .rightCommand: 54
        case .fn: 63
        }
    }

    /// The flag bit that is set while this exact key is down. The right-hand modifiers use the
    /// device-dependent bits (NX_DEVICERALTKEYMASK, NX_DEVICERCMDKEYMASK), so holding the
    /// left-hand key too doesn't hide a release.
    public var flagMask: UInt64 {
        switch self {
        case .rightOption: 0x0000_0040
        case .rightCommand: 0x0000_0010
        case .fn: 0x0080_0000 // kCGEventFlagMaskSecondaryFn
        }
    }

    /// Whether a `flagsChanged` event with this key code and flags means the key went down.
    public func isDown(keyCode: Int64, flags: UInt64) -> Bool? {
        guard keyCode == self.keyCode else { return nil }
        return flags & flagMask != 0
    }
}

/// What the app should do in response to a key event.
public enum HotkeyAction: Equatable, Sendable {
    case none
    /// Start recording (and remember the frontmost app).
    case start
    /// Stop recording and send it.
    case finish
    /// Stop recording and throw it away.
    case cancel
}

/// Hold to talk, double-tap for hands-free, Esc to cancel. Pure: times come in with the events,
/// so it is tested without a keyboard or a clock.
public struct HotkeyStateMachine: Equatable, Sendable {
    public enum State: Equatable, Sendable {
        case idle
        /// Key down and recording; since when.
        case holding(since: TimeInterval)
        /// A short tap just ended; a second press soon after means hands-free.
        case awaitingSecondTap(tapEndedAt: TimeInterval)
        /// Recording until the key is pressed again.
        case handsFree
    }

    /// Presses shorter than this aren't dictations.
    public var minimumHold: TimeInterval = 0.3
    /// How soon the second press of a double-tap must follow the first release.
    public var doubleTapWindow: TimeInterval = 0.4
    public private(set) var state: State = .idle

    public init() {}

    public var isRecording: Bool {
        switch state {
        case .holding, .handsFree: true
        case .idle, .awaitingSecondTap: false
        }
    }

    public mutating func keyDown(at time: TimeInterval) -> HotkeyAction {
        switch state {
        case .idle:
            state = .holding(since: time)
            return .start
        case let .awaitingSecondTap(tapEndedAt):
            if time - tapEndedAt <= doubleTapWindow {
                state = .handsFree
            } else {
                state = .holding(since: time)
            }
            return .start
        case .holding:
            return .none
        case .handsFree:
            state = .idle
            return .finish
        }
    }

    public mutating func keyUp(at time: TimeInterval) -> HotkeyAction {
        guard case let .holding(since) = state else { return .none }
        if time - since < minimumHold {
            state = .awaitingSecondTap(tapEndedAt: time)
            return .cancel
        }
        state = .idle
        return .finish
    }

    /// Another key pressed while the hotkey is held: a shortcut such as ⌥E, not a dictation.
    public mutating func otherKeyDown() -> HotkeyAction {
        switch state {
        case .holding:
            state = .idle
            return .cancel
        case .awaitingSecondTap:
            state = .idle
            return .none
        case .idle, .handsFree:
            return .none
        }
    }

    /// Esc: cancels a recording (and the app swallows the key); otherwise does nothing.
    public mutating func escape() -> HotkeyAction {
        guard isRecording else { return .none }
        state = .idle
        return .cancel
    }

    /// The recording ended for another reason (too long, an error): back to idle.
    public mutating func reset() {
        state = .idle
    }
}
