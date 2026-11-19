import AppKit
import DictateCore
import SwiftUI

/// Shown when a screenshot needs Screen Recording and macOS hasn't given it (docs/PLAN-screenshots.md
/// R8). Never during setup: only on a capture.
@MainActor
final class ScreenRecordingPrompt {
    private var window: NSWindow?

    func show() {
        if window == nil {
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 440, height: 220),
                styleMask: [.titled, .closable],
                backing: .buffered,
                defer: false
            )
            window.title = "Screenshots"
            window.isReleasedWhenClosed = false
            window.contentView = NSHostingView(rootView: ScreenRecordingPromptView(
                open: { Permissions.openScreenRecordingSettings() },
                close: { [weak window] in window?.close() }
            ))
            window.center()
            self.window = window
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }
}

struct ScreenRecordingPromptView: View {
    var open: () -> Void
    var close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Allow screen recording").font(.system(size: 22, weight: .semibold, design: .serif))
            Text("To take screenshots, macOS needs \(Brand.name) turned on in Privacy & Security → Screen & System Audio Recording. Shots stay on this Mac.")
                .font(.system(size: 13))
                .fixedSize(horizontal: false, vertical: true)
            Text("After you turn it on, macOS asks to quit and reopen \(Brand.name). Then press the shortcut again.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            HStack {
                Spacer()
                Button("Not now", action: close)
                Button("Open Screen Recording Settings", action: open).keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 440)
    }
}
