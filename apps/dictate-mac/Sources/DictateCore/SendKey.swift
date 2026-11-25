import Foundation

/// The key that ends a dictation and sends it: paste, then Return
/// (docs/PLAN-dictate-send-and-sounds.md, R8 to R10). The member picks it on the web; it is kept
/// on the server and remembered here.
public enum SendKey: String, CaseIterable, Codable, Sendable {
    /// How long the mic keeps listening after the send key: it is usually pressed on the last
    /// word, and stopping at once cut that word off (Morgan, 2026-11-25).
    public static let tailSeconds = 0.5

    case space
    case `return`
    case tab
    case off

    /// The keyboard's key codes for it (Return also on the keypad's Enter).
    public var keyCodes: Set<Int64> {
        switch self {
        case .space: [49]
        case .return: [36, 76]
        case .tab: [48]
        case .off: []
        }
    }

    public func matches(keyCode: Int64) -> Bool { keyCodes.contains(keyCode) }

    /// ⌘ or ⌃ held with it is a shortcut, not a send. ⌥ and ⇧ are allowed: the dictation key
    /// itself may be one of them.
    public static let shortcutFlags: UInt64 = 0x0010_0000 | 0x0004_0000 // command, control

    public func matches(keyCode: Int64, flags: UInt64) -> Bool {
        matches(keyCode: keyCode) && flags & Self.shortcutFlags == 0
    }
}

/// Whether holding ⇧ as a dictation finishes sends it (R10): not when ⇧ is the dictation key.
public func shiftSends(shiftHeld: Bool, hotkey: Hotkey) -> Bool {
    shiftHeld && hotkey != .rightShift
}

/// The member's send key and sounds as last heard from the server, so the first key press after a
/// restart already follows them.
public enum DictatePrefs {
    static let sendKeyKey = "dictateSendKey"
    static let soundsKey = "dictateSounds"

    public static func sendKey(_ defaults: UserDefaults = .standard) -> SendKey {
        defaults.string(forKey: sendKeyKey).flatMap(SendKey.init(rawValue:)) ?? .space
    }

    public static func sounds(_ defaults: UserDefaults = .standard) -> SoundTheme {
        defaults.string(forKey: soundsKey).flatMap(SoundTheme.init(rawValue:)) ?? .soft
    }

    /// From the server's answer; a value this app doesn't know keeps the last one.
    public static func remember(sendKey: String?, sounds: String?, in defaults: UserDefaults = .standard) {
        if let key = sendKey.flatMap(SendKey.init(rawValue:)) { defaults.set(key.rawValue, forKey: sendKeyKey) }
        if let theme = sounds.flatMap(SoundTheme.init(rawValue:)) { defaults.set(theme.rawValue, forKey: soundsKey) }
    }
}
