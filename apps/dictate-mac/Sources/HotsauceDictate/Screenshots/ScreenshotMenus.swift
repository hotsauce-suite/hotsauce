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

    @objc func takeScreenshot() {
        // Let the menu finish closing first, so it isn't in the picture.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            self?.screenshots.shortcutPressed()
        }
    }
}
