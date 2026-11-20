import Foundation

/// The Hotsauce and Help menus, in order (docs/PLAN-mac-app-menu.md). MainMenu builds them from
/// this list; the commands map to the app's actions there.
public enum AppMenuLayout {
    public enum Command: String, Sendable, CaseIterable {
        case about, checkForUpdates
        case settings, switchWorkspace, openAtLogin, showInMenuBar
        case restart
        case services
        case hide, hideOthers, showAll
        case quitCompletely, quit
        case help, keyboardShortcuts, sendFeedback
        case dictate, checkPermissions, runSetupAgain
        case github
    }

    public enum Modifiers: Sendable, Equatable {
        case command
        case commandOption
    }

    public enum Item: Sendable, Equatable {
        case entry(title: String, command: Command, key: String = "", modifiers: Modifiers = .command, toggle: Bool = false)
        case separator

        public var title: String? {
            if case .entry(let title, _, _, _, _) = self { return title }
            return nil
        }
        public var command: Command? {
            if case .entry(_, let command, _, _, _) = self { return command }
            return nil
        }
    }

    /// The app's own menu, Granola-style: ⌘Q leaves Hotsauce running in the menu bar (the dictation
    /// key, reminders and call detection keep working) and Quit Completely really quits.
    public static func app(name: String = Brand.name) -> [Item] {
        [
            .entry(title: "About \(name)", command: .about),
            .entry(title: "Check for Updates…", command: .checkForUpdates),
            .separator,
            .entry(title: "Settings…", command: .settings, key: ","),
            .entry(title: "Switch Workspace…", command: .switchWorkspace),
            .entry(title: "Open at Login", command: .openAtLogin, toggle: true),
            .entry(title: "Show in Menu Bar", command: .showInMenuBar, toggle: true),
            .separator,
            .entry(title: "Restart \(name)", command: .restart),
            .separator,
            .entry(title: "Services", command: .services),
            .separator,
            .entry(title: "Hide \(name)", command: .hide, key: "h"),
            .entry(title: "Hide Others", command: .hideOthers, key: "h", modifiers: .commandOption),
            .entry(title: "Show All", command: .showAll),
            .separator,
            .entry(title: "Quit Completely", command: .quitCompletely, key: "q", modifiers: .commandOption),
            .entry(title: "Quit \(name)", command: .quit, key: "q"),
        ]
    }

    /// Help: where to learn and get help, and the setup tools.
    public static func help(name: String = Brand.name) -> [Item] {
        [
            .entry(title: "\(name) Help", command: .help),
            .entry(title: "Keyboard Shortcuts", command: .keyboardShortcuts),
            .entry(title: "Send Feedback…", command: .sendFeedback),
            .separator,
            .entry(title: "Dictate…", command: .dictate),
            .entry(title: "Check Permissions…", command: .checkPermissions),
            .entry(title: "Run Setup Again…", command: .runSetupAgain),
            .separator,
            .entry(title: "\(name) on GitHub", command: .github),
        ]
    }

    /// What ⌘Q does with the windows: hidden, never closed, while something records, so nothing
    /// is cut off; closed otherwise. Either way the app keeps running.
    public enum SoftQuit: Equatable, Sendable {
        case closeWindows
        case hideApp
    }

    public static func softQuit(recording: Bool) -> SoftQuit {
        recording ? .hideApp : .closeWindows
    }
}
