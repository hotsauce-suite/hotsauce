import DictateCore
import Testing

/// docs/PLAN-mac-app-menu.md M1-M4.
struct AppMenuLayoutTests {
    @Test func appMenuIsInOrder() {
        let titles = AppMenuLayout.app(name: "Hotsauce").map { $0.title ?? "—" }
        #expect(titles == [
            "About Hotsauce", "Check for Updates…", "—",
            "Settings…", "Switch Workspace…", "Open at Login", "Show in Menu Bar", "—",
            "Restart Hotsauce", "—",
            "Services", "—",
            "Hide Hotsauce", "Hide Others", "Show All", "—",
            "Quit Completely", "Quit Hotsauce",
        ])
    }

    @Test func quitKeysMatchGranolaStyle() {
        let items = AppMenuLayout.app(name: "Hotsauce")
        #expect(items.contains(.entry(title: "Quit Hotsauce", command: .quit, key: "q")))
        #expect(items.contains(.entry(title: "Quit Completely", command: .quitCompletely, key: "q", modifiers: .commandOption)))
        #expect(items.contains(.entry(title: "Open at Login", command: .openAtLogin, toggle: true)))
        #expect(items.contains(.entry(title: "Show in Menu Bar", command: .showInMenuBar, toggle: true)))
    }

    @Test func helpMenuHoldsHelpAndSetup() {
        let titles = AppMenuLayout.help(name: "Hotsauce").map { $0.title ?? "—" }
        #expect(titles == [
            "Hotsauce Help", "Keyboard Shortcuts", "Send Feedback…", "—",
            "Dictate…", "Check Permissions…", "Run Setup Again…", "—",
            "Hotsauce on GitHub",
        ])
    }

    @Test func everyCommandHasOnePlace() {
        let commands = (AppMenuLayout.app() + AppMenuLayout.help()).compactMap(\.command)
        #expect(commands.count == Set(commands).count)
        #expect(Set(commands) == Set(AppMenuLayout.Command.allCases))
    }

    @Test func softQuitNeverClosesARecording() {
        #expect(AppMenuLayout.softQuit(recording: true) == .hideApp)
        #expect(AppMenuLayout.softQuit(recording: false) == .closeWindows)
        #expect(AboutInfo.helpURL.absoluteString == "https://hotsauce.work/help")
    }
}
