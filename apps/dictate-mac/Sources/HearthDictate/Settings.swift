import DictateCore
import Foundation

/// Preferences, in UserDefaults. The connection is in ConnectionStore; dictation history in HistoryStore.
final class Settings {
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var mode: DictationMode {
        get { DictationMode(rawValue: defaults.string(forKey: "mode") ?? "") ?? .clean }
        set { defaults.set(newValue.rawValue, forKey: "mode") }
    }

    var hotkey: Hotkey {
        get { Hotkey(rawValue: defaults.string(forKey: "hotkey") ?? "") ?? .rightOption }
        set { defaults.set(newValue.rawValue, forKey: "hotkey") }
    }

    /// How long dictation history stays on this Mac: 7, 30 or 90 days.
    var retentionDays: Int {
        get { [7, 30, 90].contains(defaults.integer(forKey: "retentionDays")) ? defaults.integer(forKey: "retentionDays") : 30 }
        set { defaults.set(newValue, forKey: "retentionDays") }
    }

    /// The menu bar icon; on by default. With it off the app is reached from Applications.
    var showInMenuBar: Bool {
        get { defaults.object(forKey: "showInMenuBar") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "showInMenuBar") }
    }

    /// The suite's server when set in Settings; otherwise the one Dictate is connected to.
    var suiteServer: URL? {
        get { defaults.string(forKey: "suiteServer").flatMap(ConnectLink.normalizedServer) }
        set { defaults.set(newValue?.absoluteString, forKey: "suiteServer") }
    }

    /// Notifications a minute before meetings; on by default.
    var meetingReminders: Bool {
        get { defaults.object(forKey: "meetingReminders") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "meetingReminders") }
    }

    /// "Take notes?" when another app starts a call; on by default.
    var offerCallNotes: Bool {
        get { defaults.object(forKey: "offerCallNotes") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "offerCallNotes") }
    }

    var hasOnboarded: Bool {
        get { defaults.bool(forKey: "hasOnboarded") }
        set { defaults.set(newValue, forKey: "hasOnboarded") }
    }
}
