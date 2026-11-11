import AppKit
import CoreGraphics
import DictateCore

/// Puts text where the cursor is: on the pasteboard, ⌘V, then the member's own pasteboard back.
enum Inserter {
    enum Outcome {
        case pasted
        /// Left on the clipboard: no Accessibility, or the member moved to another app.
        case copied
    }

    /// How long the target app gets to read the pasteboard before it is put back. Electron apps
    /// (Slack, VS Code) can take a while; restoring too soon would paste the old clipboard.
    static let restoreDelay: TimeInterval = 1.0
    /// Marks the events Hearth Dictate posts, so its own key tap ignores them.
    static let syntheticMarker: Int64 = 0x4844_4354 // "HDCT"

    static func insert(_ text: String, into target: NSRunningApplication?) -> Outcome {
        let pasteboard = NSPasteboard.general
        let frontmost = NSWorkspace.shared.frontmostApplication
        let sameApp = target == nil || frontmost?.processIdentifier == target?.processIdentifier
        guard Permissions.accessibilityGranted, sameApp else {
            copy(text)
            return .copied
        }
        let snapshot = PasteboardSnapshot.capture(pasteboard)
        let ours = PasteboardSnapshot.write(text, to: pasteboard)
        postCommandV()
        DispatchQueue.main.asyncAfter(deadline: .now() + restoreDelay) {
            snapshot.restore(to: pasteboard, ifUnchangedSince: ours)
        }
        return .pasted
    }

    /// Plain copy, for the member to paste themselves (and for "click to copy" in the menu).
    static func copy(_ text: String) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
    }

    /// ⌘V with exactly the Command flag, whatever modifiers are still held.
    private static func postCommandV() {
        let source = CGEventSource(stateID: .combinedSessionState)
        let vKey: CGKeyCode = 9
        let down = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: true)
        let up = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: false)
        for event in [down, up] {
            event?.flags = .maskCommand
            event?.setIntegerValueField(.eventSourceUserData, value: syntheticMarker)
        }
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
    }
}
