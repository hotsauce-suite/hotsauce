import Foundation

/// Settings → This Mac in the app's window (docs/PLAN-one-settings.md). The page reads and changes
/// the app's own settings with `webkit.messageHandlers.hotsauceMacSettings.postMessage`:
/// `{type: 'hello'}` (this web app has the page), `{type: 'get'}`, `{type: 'set', key, value}` and
/// `{type: 'action', action}`. Every answer but hello's is the whole snapshot. Parsing is strict
/// (R9): anything unknown, or a value of the wrong kind, is no request at all.
public enum MacSettingsBridge {
    /// The script message handler the page posts to.
    public static let handlerName = "hotsauceMacSettings"

    public enum Change: Equatable, Sendable {
        case hotkey(Hotkey)
        case mode(DictationMode)
        case edgeGlow(Bool)
        case meetingReminders(Bool)
        case offerCallNotes(Bool)
        case openAtLogin(Bool)
        case showInMenuBar(Bool)
        case historyDays(Int)
    }

    public enum Action: String, CaseIterable, Sendable {
        case allowMicrophone, allowAccessibility, allowLocation, allowNotifications
        case openNotificationSettings, runSetup, clearHistory, disconnect
    }

    public enum Request: Equatable, Sendable {
        case hello
        case get
        case set(Change)
        case action(Action)
    }

    /// How long dictation history can be kept, as Settings has always offered.
    public static let historyDays = [7, 30, 90]

    public static func parse(_ body: Any) -> Request? {
        guard let message = body as? [String: Any], let type = message["type"] as? String else { return nil }
        switch type {
        case "hello": return message.count == 1 ? .hello : nil
        case "get": return message.count == 1 ? .get : nil
        case "action":
            guard message.count == 2, let name = message["action"] as? String, let action = Action(rawValue: name) else { return nil }
            return .action(action)
        case "set":
            guard message.count == 3, let key = message["key"] as? String, let value = message["value"] else { return nil }
            return change(key: key, value: value).map(Request.set)
        default: return nil
        }
    }

    private static func change(key: String, value: Any) -> Change? {
        switch key {
        case "hotkey": return string(value).flatMap(Hotkey.init(rawValue:)).map(Change.hotkey)
        case "mode": return string(value).flatMap(DictationMode.init(rawValue:)).map(Change.mode)
        case "edgeGlow": return flag(value).map(Change.edgeGlow)
        case "meetingReminders": return flag(value).map(Change.meetingReminders)
        case "offerCallNotes": return flag(value).map(Change.offerCallNotes)
        case "openAtLogin": return flag(value).map(Change.openAtLogin)
        case "showInMenuBar": return flag(value).map(Change.showInMenuBar)
        case "historyDays":
            guard let days = number(value), historyDays.contains(days) else { return nil }
            return .historyDays(days)
        default: return nil
        }
    }

    private static func string(_ value: Any) -> String? { value as? String }

    /// A JavaScript boolean only: WebKit hands both booleans and numbers over as NSNumber.
    private static func flag(_ value: Any) -> Bool? {
        isBoolean(value) ? value as? Bool : nil
    }

    private static func number(_ value: Any) -> Int? {
        guard !isBoolean(value), let number = value as? NSNumber else { return nil }
        let double = number.doubleValue
        guard double == double.rounded() else { return nil }
        return Int(double)
    }

    private static func isBoolean(_ value: Any) -> Bool {
        if value is Bool, !(value is NSNumber) { return true }
        guard let number = value as? NSNumber else { return false }
        return CFGetTypeID(number) == CFBooleanGetTypeID()
    }

    /// What the page shows, as the Mac has it now.
    public struct Snapshot: Equatable, Sendable {
        public var hotkey: Hotkey
        public var mode: DictationMode
        public var edgeGlow: Bool
        public var meetingReminders: Bool
        public var offerCallNotes: Bool
        /// Call detection needs macOS 14.2.
        public var callNotesSupported: Bool
        public var openAtLogin: Bool
        public var showInMenuBar: Bool
        public var menuBarIconHidden: Bool
        public var historyDays: Int
        public var microphone: Bool
        public var accessibility: Bool
        public var location: Bool
        public var notifications: NotificationsBridge.State
        public var account: String?

        public init(
            hotkey: Hotkey, mode: DictationMode, edgeGlow: Bool, meetingReminders: Bool, offerCallNotes: Bool, callNotesSupported: Bool,
            openAtLogin: Bool, showInMenuBar: Bool, menuBarIconHidden: Bool, historyDays: Int,
            microphone: Bool, accessibility: Bool, location: Bool, notifications: NotificationsBridge.State, account: String?
        ) {
            self.hotkey = hotkey
            self.mode = mode
            self.edgeGlow = edgeGlow
            self.meetingReminders = meetingReminders
            self.offerCallNotes = offerCallNotes
            self.callNotesSupported = callNotesSupported
            self.openAtLogin = openAtLogin
            self.showInMenuBar = showInMenuBar
            self.menuBarIconHidden = menuBarIconHidden
            self.historyDays = historyDays
            self.microphone = microphone
            self.accessibility = accessibility
            self.location = location
            self.notifications = notifications
            self.account = account
        }

        /// As the page reads it (apps/web/src/lib/macSettings.ts parseMacSettings).
        public var reply: [String: Any] {
            [
                "hotkey": hotkey.rawValue,
                "mode": mode.rawValue,
                "edgeGlow": edgeGlow,
                "meetingReminders": meetingReminders,
                "offerCallNotes": offerCallNotes,
                "callNotesSupported": callNotesSupported,
                "openAtLogin": openAtLogin,
                "showInMenuBar": showInMenuBar,
                "menuBarIconHidden": menuBarIconHidden,
                "historyDays": historyDays,
                "permissions": [
                    "microphone": microphone,
                    "accessibility": accessibility,
                    "location": location,
                    "notifications": notifications.rawValue,
                ] as [String: Any],
                "account": account ?? NSNull(),
            ]
        }
    }
}

/// Whether ⌘, can open This Mac in the main window, or needs the app's own small window (R11).
public enum SettingsDestination: Equatable, Sendable {
    case thisMacPage
    case fallbackWindow

    /// This Mac only once the page loaded now has said hello: a workspace that's unreachable, or
    /// whose web app predates the page, gets the fallback.
    public static func choose(pageSaidHello: Bool, pageLoaded: Bool) -> SettingsDestination {
        pageSaidHello && pageLoaded ? .thisMacPage : .fallbackWindow
    }

    /// The suite's address for This Mac.
    public static let path = "/settings/mac"
}
