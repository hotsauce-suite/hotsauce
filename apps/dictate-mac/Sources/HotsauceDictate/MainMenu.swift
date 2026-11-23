import AppKit
import DictateCore
import ServiceManagement

/// The menu bar of the app, now that it's a Dock app: the standard App, File, Edit (copy and paste
/// in the web view need it), View, Go (back, forward, the rail's apps on ⌘1…) and Window menus.
extension AppDelegate: NSMenuItemValidation {
    func makeMainMenu() -> NSMenu {
        let main = NSMenu()

        // The Hotsauce menu (docs/PLAN-mac-app-menu.md), from DictateCore's AppMenuLayout.
        let app = submenu(Brand.name, in: main)
        for item in AppMenuLayout.app() {
            guard case .entry(_, let command, _, _, _) = item else {
                app.addItem(.separator())
                continue
            }
            if command == .services {
                let services = NSMenu(title: "Services")
                app.addItem(withTitle: "Services", action: nil, keyEquivalent: "").submenu = services
                NSApp.servicesMenu = services
                continue
            }
            app.addItem(menuItem(item))
            if command == .about {
                // An Easter egg (docs/PLAN-easter-eggs.md E9): hold Option and About becomes this.
                let heat = entry("Add more heat 🌶", #selector(addMoreHeat), "")
                heat.keyEquivalentModifierMask = [.option]
                heat.isAlternate = true
                app.addItem(heat)
            }
        }

        let file = submenu("File", in: main)
        file.addItem(screenshotMenuItem(title: "Take Screenshot"))
        for item in screenshotEditItems() { file.addItem(item) }
        file.addItem(withTitle: "Share Screenshot", action: #selector(EditorCanvas.shareScreenshot(_:)), keyEquivalent: "")
        file.addItem(.separator())
        // A Doc as Word or PDF (docs/PLAN-doc-download.md R10): ⌘⇧E.
        file.addItem(entry("Export…", #selector(exportDoc), "E"))
        file.addItem(.separator())
        file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")

        let edit = submenu("Edit", in: main)
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        let plain = edit.addItem(withTitle: "Paste and Match Style", action: #selector(NSTextView.pasteAsPlainText(_:)), keyEquivalent: "V")
        plain.keyEquivalentModifierMask = [.command, .option, .shift]
        edit.addItem(withTitle: "Delete", action: #selector(NSText.delete(_:)), keyEquivalent: "")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        let view = submenu("View", in: main)
        view.addItem(entry("Reload Page", #selector(reloadSuite), "r"))
        view.addItem(.separator())
        view.addItem(entry("Actual Size", #selector(actualSize), "0"))
        view.addItem(entry("Zoom In", #selector(zoomIn), "+"))
        view.addItem(entry("Zoom Out", #selector(zoomOut), "-"))
        view.addItem(.separator())
        // A Doc as slides (docs/PLAN-slides.md R11): ⌘⌥P.
        let present = entry("Present", #selector(presentDoc), "p")
        present.keyEquivalentModifierMask = [.command, .option]
        view.addItem(present)
        let fullScreen = view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]

        let go = submenu("Go", in: main)
        go.addItem(entry("Back", #selector(goBack), "["))
        go.addItem(entry("Forward", #selector(goForward), "]"))
        let home = entry("Home", #selector(goHome), "H")
        go.addItem(home)
        go.addItem(.separator())
        for (index, shortcut) in Brand.railShortcuts.enumerated() {
            let key = index < 9 ? "\(index + 1)" : ""
            let item = entry(shortcut.title, #selector(openRailApp(_:)), key)
            item.tag = index
            go.addItem(item)
        }

        // Background music (docs/PLAN-background-music.md M9): filled when it opens.
        main.addItem(withTitle: "Music", action: nil, keyEquivalent: "").submenu = musicMenu.makeMenu()

        let window = submenu("Window", in: main)
        window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        window.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        window.addItem(.separator())
        window.addItem(entry(Brand.name, #selector(showSuiteWindow), ""))
        window.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        NSApp.windowsMenu = window

        let help = submenu("Help", in: main)
        for item in AppMenuLayout.help() {
            if case .separator = item { help.addItem(.separator()) } else { help.addItem(menuItem(item)) }
        }
        NSApp.helpMenu = help

        return main
    }

    private func submenu(_ title: String, in main: NSMenu) -> NSMenu {
        let menu = NSMenu(title: title)
        main.addItem(withTitle: title, action: nil, keyEquivalent: "").submenu = menu
        return menu
    }

    /// An AppMenuLayout entry as a menu item, wired to its action.
    private func menuItem(_ item: AppMenuLayout.Item) -> NSMenuItem {
        guard case .entry(let title, let command, let key, let modifiers, _) = item else { return .separator() }
        let made: NSMenuItem
        switch command {
        case .hide: made = NSMenuItem(title: title, action: #selector(NSApplication.hide(_:)), keyEquivalent: key)
        case .hideOthers: made = NSMenuItem(title: title, action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: key)
        case .showAll: made = NSMenuItem(title: title, action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: key)
        default: made = entry(title, selector(for: command), key)
        }
        made.keyEquivalentModifierMask = modifiers == .commandOption ? [.command, .option] : [.command]
        made.representedObject = command.rawValue
        return made
    }

    private func selector(for command: AppMenuLayout.Command) -> Selector {
        switch command {
        case .about: return #selector(showAbout)
        case .checkForUpdates: return #selector(checkForUpdatesNow)
        case .settings: return #selector(openSettings)
        case .switchWorkspace: return #selector(switchWorkspace)
        case .openAtLogin: return #selector(toggleOpenAtLoginFromMenu)
        case .showInMenuBar: return #selector(toggleShowInMenuBarFromMenu)
        case .restart: return #selector(restartFromMenu)
        case .quitCompletely: return #selector(quitCompletely)
        case .quit: return #selector(softQuit)
        case .help: return #selector(openHelp)
        case .keyboardShortcuts: return #selector(showKeyboardShortcuts)
        case .chromeExtension: return #selector(openChromeExtension)
        case .sendFeedback: return #selector(sendFeedback)
        case .dictate: return #selector(openDictateWindow)
        case .checkPermissions: return #selector(showOnboarding)
        case .runSetupAgain: return #selector(runSetupAgain)
        case .github: return #selector(openGitHub)
        // Built by menuItem and makeMainMenu themselves; never asked for.
        case .services, .hide, .hideOthers, .showAll: return #selector(showSuiteWindow)
        }
    }

    private func entry(_ title: String, _ action: Selector, _ key: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    /// Back, Forward, Reload and zoom act on the suite's window, so only while it's in front.
    func validateMenuItem(_ item: NSMenuItem) -> Bool {
        switch item.action {
        case #selector(goBack): return suite.isKey && suite.canGoBack
        case #selector(goForward): return suite.isKey && suite.canGoForward
        case #selector(reloadSuite), #selector(actualSize), #selector(zoomIn), #selector(zoomOut): return suite.isKey
        case #selector(editLastScreenshot): return screenshots.recent.newest != nil
        case #selector(checkForUpdatesNow): return !isCheckingForUpdates
        case #selector(toggleOpenAtLoginFromMenu):
            item.state = SMAppService.mainApp.status == .enabled ? .on : .off
            return true
        case #selector(toggleShowInMenuBarFromMenu):
            item.state = showsMenuBarIcon ? .on : .off
            return true
        case #selector(takeScreenshot): return refreshScreenshotItem(item)
        default: return true
        }
    }

    /// Settings → This Mac in the main window; the Dictate window's small Settings only when the
    /// main window can't show it (docs/PLAN-one-settings.md R10, R11).
    @objc func openSettings() {
        switch suite.settingsDestination {
        case .thisMacPage:
            suite.show()
            suite.open(path: SettingsDestination.path)
        case .fallbackWindow:
            mainWindow.show(page: .settings)
        }
    }
    /// Dictate → On this Mac in the main window; the old Dictate window only when the main window
    /// can't show it (docs/PLAN-dictations-page.md R7).
    @objc func openDictateWindow() {
        switch suite.dictationsDestination {
        case .thisMacPage:
            suite.show()
            suite.open(path: SettingsDestination.dictationsPath)
        case .fallbackWindow:
            mainWindow.show(page: .dictations)
        }
    }
    @objc func showSuiteWindow() { suite.show() }
    @objc func openHelp() { NSWorkspace.shared.open(AboutInfo.helpURL) }
    @objc func openGitHub() { NSWorkspace.shared.open(AboutInfo.sourceURL) }
    /// The page's keyboard shortcuts sheet (the same as pressing ?).
    @objc func showKeyboardShortcuts() {
        suite.show()
        suite.showKeyboardShortcuts()
    }
    /// The Chrome extension's page: how it and this app share calls (docs/PLAN-extension-setup.md).
    @objc func openChromeExtension() {
        suite.show()
        suite.open(path: "/meetings/extension")
    }
    @objc func sendFeedback() {
        suite.show()
        suite.open(path: "/feedback")
    }
    /// The standard About panel, with a link to the source on GitHub under the version.
    @objc func showAbout() {
        NSApp.activate(ignoringOtherApps: true)
        NSApp.orderFrontStandardAboutPanel(options: [.credits: Self.aboutCredits()])
    }
    static func aboutCredits() -> NSAttributedString {
        let centered = NSMutableParagraphStyle()
        centered.alignment = .center
        let small = NSFont.systemFont(ofSize: NSFont.smallSystemFontSize)
        let text = NSMutableAttributedString(string: "Open source on GitHub\n", attributes: [
            .font: small, .foregroundColor: NSColor.secondaryLabelColor, .paragraphStyle: centered,
        ])
        text.append(NSAttributedString(string: AboutInfo.sourceLabel, attributes: [
            .font: small, .link: AboutInfo.sourceURL, .paragraphStyle: centered,
        ]))
        return text
    }
    @objc func addMoreHeat() {
        suite.show()
        suite.addMoreHeat()
    }
    @objc func reloadSuite() { suite.reload() }
    @objc func exportDoc() {
        suite.show()
        suite.exportOpenDoc()
    }
    @objc func presentDoc() {
        suite.show()
        suite.presentOpenDoc()
    }
    @objc func goBack() { suite.goBack() }
    @objc func goForward() { suite.goForward() }
    @objc func goHome() {
        suite.show()
        suite.goHome()
    }

    @objc func openRailApp(_ sender: NSMenuItem) {
        guard Brand.railShortcuts.indices.contains(sender.tag) else { return }
        suite.show()
        suite.open(path: Brand.railShortcuts[sender.tag].path)
    }

    @objc func actualSize() { suite.webView.pageZoom = 1 }
    @objc func zoomIn() { suite.webView.pageZoom = min(3, suite.webView.pageZoom + 0.1) }
    @objc func zoomOut() { suite.webView.pageZoom = max(0.5, suite.webView.pageZoom - 0.1) }
}
