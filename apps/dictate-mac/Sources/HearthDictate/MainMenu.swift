import AppKit
import DictateCore

/// The menu bar of the app, now that it's a Dock app: the standard App, File, Edit (copy and paste
/// in the web view need it), View, Go (back, forward, the rail's apps on ⌘1…) and Window menus.
extension AppDelegate: NSMenuItemValidation {
    func makeMainMenu() -> NSMenu {
        let main = NSMenu()

        let app = submenu(Brand.name, in: main)
        app.addItem(withTitle: "About \(Brand.name)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(entry("Settings…", #selector(openSettings), ","))
        app.addItem(entry("Dictate…", #selector(openDictateWindow), ""))
        app.addItem(.separator())
        let services = NSMenu(title: "Services")
        app.addItem(withTitle: "Services", action: nil, keyEquivalent: "").submenu = services
        NSApp.servicesMenu = services
        app.addItem(.separator())
        app.addItem(withTitle: "Hide \(Brand.name)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let others = app.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        others.keyEquivalentModifierMask = [.command, .option]
        app.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Quit \(Brand.name)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let file = submenu("File", in: main)
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

        let window = submenu("Window", in: main)
        window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        window.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        window.addItem(.separator())
        window.addItem(entry(Brand.name, #selector(showSuiteWindow), ""))
        window.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        NSApp.windowsMenu = window

        return main
    }

    private func submenu(_ title: String, in main: NSMenu) -> NSMenu {
        let menu = NSMenu(title: title)
        main.addItem(withTitle: title, action: nil, keyEquivalent: "").submenu = menu
        return menu
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
        default: return true
        }
    }

    @objc func openSettings() { mainWindow.show(page: .settings) }
    @objc func openDictateWindow() { mainWindow.show(page: .dictations) }
    @objc func showSuiteWindow() { suite.show() }
    @objc func reloadSuite() { suite.reload() }
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
