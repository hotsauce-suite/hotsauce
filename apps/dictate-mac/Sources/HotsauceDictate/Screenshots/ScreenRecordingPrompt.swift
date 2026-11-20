import AppKit
import DictateCore
import SwiftUI

/// Shown when a screenshot fails for Screen Recording (docs/PLAN-screenshots.md R8). Never during
/// setup: only on a capture. What it says depends on what happened before
/// (`ScreenRecordingCheck.advice`).
@MainActor
final class ScreenRecordingPrompt {
    private var window: NSWindow?
    var relaunch: () -> Void = {}

    func show(_ advice: ScreenRecordingCheck.Advice) {
        window?.close()
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 240),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Screenshots"
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: ScreenRecordingPromptView(
            advice: advice,
            open: { Permissions.openScreenRecordingSettings() },
            relaunch: { [weak self] in self?.relaunch() },
            close: { [weak window] in window?.close() }
        ))
        window.center()
        self.window = window
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }
}

struct ScreenRecordingPromptView: View {
    var advice: ScreenRecordingCheck.Advice
    var open: () -> Void
    var relaunch: () -> Void
    var close: () -> Void

    private var title: String {
        advice == .removeAndAddAgain ? "Screen recording still isn’t working" : "Allow screen recording"
    }

    private var lead: String {
        switch advice {
        case .turnOn, .restart:
            return "To take screenshots, macOS needs \(Brand.name) turned on in Privacy & Security → Screen & System Audio Recording. Shots stay on this Mac."
        case .removeAndAddAgain:
            return "macOS still isn’t letting \(Brand.name) record the screen, even after a restart. The switch in the list is probably left from an older copy of \(Brand.name)."
        }
    }

    private var next: String {
        switch advice {
        case .turnOn:
            return "The switch only counts after \(Brand.name) restarts: turn it on, then press Quit and Reopen."
        case .restart:
            return "If it’s already on, it only counts after \(Brand.name) restarts. Press Quit and Reopen, then press the shortcut again."
        case .removeAndAddAgain:
            return "In the list, select \(Brand.name) and press − to remove it. Then press the shortcut again, turn \(Brand.name) on when it appears, and press Quit and Reopen."
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.system(size: 22, weight: .semibold, design: .serif))
            Text(lead)
                .font(.system(size: 13))
                .fixedSize(horizontal: false, vertical: true)
            Text(next)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            HStack {
                Button("Not now", action: close)
                Spacer()
                Button("Open Settings", action: open)
                Button("Quit and Reopen \(Brand.name)", action: relaunch).keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 460)
    }
}
