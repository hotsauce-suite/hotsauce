import Foundation

// The screenshot shortcut (docs/PLAN-screenshots.md R7): a chord of modifiers and one key, ⌥⇧4 by
// default. Pure, so parsing, showing and matching are tested without a keyboard.

/// A chord such as ⌥⇧4: modifiers held, then a key pressed. Stored as the text it shows ("⌥⇧4").
public struct ScreenshotShortcut: Equatable, Hashable, Sendable {
    /// The four modifiers a chord can use. The raw values are the device-independent bits of
    /// `CGEventFlags` and `NSEvent.ModifierFlags`, which are the same.
    public struct Modifiers: OptionSet, Hashable, Sendable {
        public let rawValue: UInt64
        public init(rawValue: UInt64) { self.rawValue = rawValue }

        public static let shift = Modifiers(rawValue: 0x0002_0000)
        public static let control = Modifiers(rawValue: 0x0004_0000)
        public static let option = Modifiers(rawValue: 0x0008_0000)
        public static let command = Modifiers(rawValue: 0x0010_0000)

        static let all: Modifiers = [.shift, .control, .option, .command]

        /// The modifiers in an event's flags. Caps Lock, Fn (set for arrows and F-keys), the
        /// numeric pad bit and the left/right device bits are all left out.
        public init(flags: UInt64) {
            self.init(rawValue: flags & Modifiers.all.rawValue)
        }

        /// In Apple's order: ⌃⌥⇧⌘.
        public var symbols: String {
            var text = ""
            if contains(.control) { text += "⌃" }
            if contains(.option) { text += "⌥" }
            if contains(.shift) { text += "⇧" }
            if contains(.command) { text += "⌘" }
            return text
        }
    }

    /// The virtual key code (kVK_…), as on a US keyboard.
    public var keyCode: Int64
    public var modifiers: Modifiers

    public init(keyCode: Int64, modifiers: Modifiers) {
        self.keyCode = keyCode
        self.modifiers = modifiers
    }

    /// ⌥⇧4.
    public static let `default` = ScreenshotShortcut(keyCode: 21, modifiers: [.option, .shift])

    /// A chord needs ⌘, ⌥ or ⌃: with ⇧ alone, or nothing, it would swallow ordinary typing.
    public var isUsable: Bool {
        !modifiers.intersection([.command, .option, .control]).isEmpty && Self.keyNames[keyCode] != nil
    }

    /// "⌥⇧4".
    public var display: String { modifiers.symbols + (Self.keyNames[keyCode] ?? "?") }

    /// Reads "⌥⇧4" (or "⇧⌥4": the order of the modifiers doesn't matter). Nil for text that
    /// isn't modifiers followed by one known key.
    public init?(parsing text: String) {
        var modifiers: Modifiers = []
        var rest = Substring(text.trimmingCharacters(in: .whitespaces))
        while let first = rest.first, let modifier = Self.modifierSymbols[first] {
            modifiers.insert(modifier)
            rest = rest.dropFirst()
        }
        let name = rest.uppercased()
        guard let keyCode = Self.keyNames.first(where: { $0.value.uppercased() == name })?.key else { return nil }
        self.init(keyCode: keyCode, modifiers: modifiers)
    }

    /// Whether a keyDown with this key code and flags is this chord: the same key and exactly
    /// the same modifiers (⌥⇧4 doesn't fire for ⌘⌥⇧4).
    public func matches(keyCode: Int64, flags: UInt64) -> Bool {
        keyCode == self.keyCode && Modifiers(flags: flags) == modifiers
    }

    /// The character for a menu item's key equivalent ("4"), or nil for keys a menu can't show.
    public var keyEquivalent: String? {
        guard let name = Self.keyNames[keyCode], name.count == 1, name.first?.isASCII == true else { return nil }
        return name.lowercased()
    }

    private static let modifierSymbols: [Character: Modifiers] = ["⌃": .control, "⌥": .option, "⇧": .shift, "⌘": .command]

    /// What each key is called, by key code (US layout, as macOS's own shortcuts are shown).
    static let keyNames: [Int64: String] = {
        var names: [Int64: String] = [
            0: "A", 1: "S", 2: "D", 3: "F", 4: "H", 5: "G", 6: "Z", 7: "X", 8: "C", 9: "V",
            11: "B", 12: "Q", 13: "W", 14: "E", 15: "R", 16: "Y", 17: "T", 31: "O", 32: "U",
            34: "I", 35: "P", 37: "L", 38: "J", 40: "K", 45: "N", 46: "M",
            18: "1", 19: "2", 20: "3", 21: "4", 22: "6", 23: "5", 25: "9", 26: "7", 28: "8", 29: "0",
            24: "=", 27: "-", 30: "]", 33: "[", 39: "'", 41: ";", 42: "\\", 43: ",", 44: "/", 47: ".", 50: "`",
            36: "↩", 48: "⇥", 49: "Space", 51: "⌫",
            123: "←", 124: "→", 125: "↓", 126: "↑",
        ]
        let functionKeys: [Int64] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111]
        for (index, code) in functionKeys.enumerated() { names[code] = "F\(index + 1)" }
        return names
    }()
}

extension ScreenshotShortcut: Codable {
    public init(from decoder: Decoder) throws {
        let text = try decoder.singleValueContainer().decode(String.self)
        guard let shortcut = ScreenshotShortcut(parsing: text) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Not a shortcut: \(text)"))
        }
        self = shortcut
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(display)
    }
}

/// Where the screenshot preferences live in UserDefaults (Settings → This Mac changes them in slice 4).
public enum ScreenshotSettings {
    public static let shortcutKey = "screenshotShortcut"
    public static let folderKey = "screenshotFolder"

    /// The saved chord, or ⌥⇧4 when none is saved or the saved one can't be used.
    public static func shortcut(_ defaults: UserDefaults) -> ScreenshotShortcut {
        guard let text = defaults.string(forKey: shortcutKey),
              let shortcut = ScreenshotShortcut(parsing: text), shortcut.isUsable, shortcut.refusal == nil
        else { return .default }
        return shortcut
    }

    public static func setShortcut(_ shortcut: ScreenshotShortcut, in defaults: UserDefaults) {
        defaults.set(shortcut.display, forKey: shortcutKey)
    }

    /// The folder shots are saved in: the saved path, or ~/Pictures/Hotsauce Screenshots.
    public static func folder(_ defaults: UserDefaults, home: URL) -> URL {
        if let path = defaults.string(forKey: folderKey), !path.isEmpty {
            return URL(fileURLWithPath: (path as NSString).expandingTildeInPath, isDirectory: true)
        }
        return home.appendingPathComponent("Pictures/Hotsauce Screenshots", isDirectory: true)
    }

    /// The folder as people read it: ~ for the home folder.
    public static func displayPath(_ folder: URL, home: URL) -> String {
        let path = folder.standardizedFileURL.path, homePath = home.standardizedFileURL.path
        if path == homePath { return "~" }
        return path.hasPrefix(homePath + "/") ? "~" + path.dropFirst(homePath.count) : path
    }

    public static func setFolder(_ folder: URL, in defaults: UserDefaults) {
        defaults.set(folder.path, forKey: folderKey)
    }
}
