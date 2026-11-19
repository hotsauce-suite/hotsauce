import AppKit
import DictateCore

/// Take Screenshot in the app's menu and the menu bar menu, showing the shortcut (works even when
/// the key tap isn't running).
extension AppDelegate {
    func screenshotMenuItem(title: String) -> NSMenuItem {
        let shortcut = screenshots.shortcut
        let item = NSMenuItem(title: title, action: #selector(takeScreenshot), keyEquivalent: shortcut.keyEquivalent ?? "")
        item.keyEquivalentModifierMask = NSEvent.ModifierFlags(rawValue: UInt(shortcut.modifiers.rawValue))
        item.target = self
        return item
    }

    /// Keeps the item's shortcut current after Settings changes it.
    func refreshScreenshotItem(_ item: NSMenuItem) -> Bool {
        let shortcut = screenshots.shortcut
        item.keyEquivalent = shortcut.keyEquivalent ?? ""
        item.keyEquivalentModifierMask = NSEvent.ModifierFlags(rawValue: UInt(shortcut.modifiers.rawValue))
        return true
    }

    @objc func takeScreenshot() {
        // Let the menu finish closing first, so it isn't in the picture.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            self?.screenshots.shortcutPressed()
        }
    }
}

/// File → Edit Last Screenshot and Recent Screenshots (the last five, newest first).
extension AppDelegate {
    func screenshotEditItems() -> [NSMenuItem] {
        let last = NSMenuItem(title: "Edit Last Screenshot", action: #selector(editLastScreenshot), keyEquivalent: "")
        last.target = self
        let recent = NSMenuItem(title: "Recent Screenshots", action: nil, keyEquivalent: "")
        let menu = NSMenu(title: "Recent Screenshots")
        menu.delegate = recentScreenshotsMenu
        recent.submenu = menu
        return [last, recent]
    }

    @objc func editLastScreenshot() {
        screenshots.editLast()
    }
}

/// Fills Recent Screenshots when it opens.
@MainActor
final class RecentScreenshotsMenu: NSObject, NSMenuDelegate {
    let controller: () -> ScreenshotController

    init(controller: @escaping () -> ScreenshotController) {
        self.controller = controller
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let shots = controller().recent.items
        if shots.isEmpty {
            let none = NSMenuItem(title: "No screenshots yet", action: nil, keyEquivalent: "")
            none.isEnabled = false
            menu.addItem(none)
        }
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .medium
        for (index, shot) in shots.enumerated() {
            let item = NSMenuItem(title: "\(formatter.string(from: shot.takenAt))  ·  \(shot.image.width) × \(shot.image.height)", action: #selector(open(_:)), keyEquivalent: "")
            item.target = self
            item.tag = index
            menu.addItem(item)
        }
    }

    @objc private func open(_ sender: NSMenuItem) {
        let shots = controller().recent.items
        guard shots.indices.contains(sender.tag) else { return }
        controller().edit(shots[sender.tag])
    }
}
