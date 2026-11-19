import AppKit
import DictateCore

/// The background music in the app's menus (docs/PLAN-background-music.md M9): the menu bar menu's
/// "Play music" / "Pause music", and the top menu's Music menu with the tracks. The page plays it;
/// these only ask the page, so they show only once a page with the player has loaded.
@MainActor
final class MusicMenu: NSObject, NSMenuDelegate {
    private let suite: () -> SuiteWindow

    init(suite: @escaping () -> SuiteWindow) {
        self.suite = suite
    }

    /// The menu bar menu's lines: the toggle and, while on, what's playing.
    func statusItems() -> [NSMenuItem] {
        guard let state = suite().music else { return [] }
        var items = [entry(state.toggleTitle, #selector(toggle))]
        if let status = state.status {
            let line = NSMenuItem(title: status, action: nil, keyEquivalent: "")
            line.isEnabled = false
            items.append(line)
        }
        return items
    }

    /// The top menu's Music menu, filled each time it opens.
    func makeMenu() -> NSMenu {
        let menu = NSMenu(title: "Music")
        menu.delegate = self
        menu.autoenablesItems = false
        return menu
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        guard let state = suite().music else {
            menu.addItem(entry("Open \(Brand.name) to play music", #selector(openSuite)))
            return
        }
        menu.addItem(entry(state.toggleTitle, #selector(toggle)))
        if let status = state.status {
            let line = NSMenuItem(title: status, action: nil, keyEquivalent: "")
            line.isEnabled = false
            menu.addItem(line)
        }
        menu.addItem(.separator())
        for track in state.tracks {
            let item = entry(track.label, #selector(pickTrack(_:)))
            item.representedObject = track.id
            item.state = state.on && state.track == track.id ? .on : .off
            menu.addItem(item)
        }
    }

    private func entry(_ title: String, _ action: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        item.isEnabled = true
        return item
    }

    @objc private func openSuite() { suite().show() }

    @objc private func toggle() { suite().musicCommand(.toggle) }

    @objc private func pickTrack(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        suite().musicCommand(.track(id))
    }
}
