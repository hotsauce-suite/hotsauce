import AppKit
import CoreGraphics
import DictateCore

/// Watches the keyboard everywhere with a CGEventTap (needs Accessibility) and turns the hotkey
/// into the state machine's events. Swallows Esc only while a dictation is recording.
final class HotkeyMonitor {
    enum Event {
        case keyDown(TimeInterval)
        case keyUp(TimeInterval)
        case otherKey
        case escape
    }

    var hotkey: Hotkey
    /// Called on the main thread. For `.escape`, return true to swallow the key.
    var handler: (Event) -> Bool = { _ in false }

    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var hotkeyIsDown = false
    private static let escapeKeyCode: Int64 = 53

    init(hotkey: Hotkey) {
        self.hotkey = hotkey
    }

    var isRunning: Bool { tap.map { CGEvent.tapIsEnabled(tap: $0) } ?? false }

    /// Starts the tap; false when Accessibility isn't granted yet.
    @discardableResult
    func start() -> Bool {
        if let tap {
            // macOS can switch a tap off; switching it back on is usually all it needs.
            if CFMachPortIsValid(tap), !CGEvent.tapIsEnabled(tap: tap) { CGEvent.tapEnable(tap: tap, enable: true) }
            if CFMachPortIsValid(tap), CGEvent.tapIsEnabled(tap: tap) { return true }
            // A tap that died (Accessibility turned off and on again) is made afresh.
            stop()
        }
        let mask = (1 << CGEventType.flagsChanged.rawValue) | (1 << CGEventType.keyDown.rawValue)
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: CGEventMask(mask),
            callback: { _, type, event, refcon in
                guard let refcon else { return Unmanaged.passUnretained(event) }
                let monitor = Unmanaged<HotkeyMonitor>.fromOpaque(refcon).takeUnretainedValue()
                return monitor.handle(type: type, event: event)
            },
            userInfo: refcon
        ) else { return false }
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        self.tap = tap
        self.source = source
        return true
    }

    func stop() {
        if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        tap = nil
        source = nil
        hotkeyIsDown = false
    }

    private func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        // Our own ⌘V must not read as a shortcut that cancels the next dictation.
        if event.getIntegerValueField(.eventSourceUserData) == Inserter.syntheticMarker {
            return Unmanaged.passUnretained(event)
        }
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            // macOS turns a slow tap off; turn it back on, and catch up on a release missed meanwhile.
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            let flags = CGEventSource.flagsState(.combinedSessionState).rawValue
            if hotkeyIsDown, flags & hotkey.flagMask == 0 {
                hotkeyIsDown = false
                _ = handler(.keyUp(ProcessInfo.processInfo.systemUptime))
            }
            return Unmanaged.passUnretained(event)
        case .flagsChanged:
            let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
            if let down = hotkey.isDown(keyCode: keyCode, flags: event.flags.rawValue), down != hotkeyIsDown {
                hotkeyIsDown = down
                let time = TimeInterval(event.timestamp) / 1_000_000_000
                _ = handler(down ? .keyDown(time) : .keyUp(time))
            }
            return Unmanaged.passUnretained(event)
        case .keyDown:
            let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
            if keyCode == Self.escapeKeyCode {
                return handler(.escape) ? nil : Unmanaged.passUnretained(event)
            }
            // Key repeats of a held key aren't new shortcuts.
            if event.getIntegerValueField(.keyboardEventAutorepeat) == 0 { _ = handler(.otherKey) }
            return Unmanaged.passUnretained(event)
        default:
            return Unmanaged.passUnretained(event)
        }
    }
}
