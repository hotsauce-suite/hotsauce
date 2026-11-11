import AppKit
import ApplicationServices
import AVFoundation

/// Microphone and Accessibility: what Hearth Dictate needs, and the System Settings panes for them.
enum Permissions {
    static var microphone: AVAuthorizationStatus {
        AVCaptureDevice.authorizationStatus(for: .audio)
    }

    static var microphoneGranted: Bool { microphone == .authorized }

    /// Accessibility lets the app see the hotkey everywhere and paste with ⌘V.
    static var accessibilityGranted: Bool { AXIsProcessTrusted() }

    static func requestMicrophone(_ done: @escaping (Bool) -> Void) {
        if microphone == .notDetermined {
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                DispatchQueue.main.async { done(granted) }
            }
        } else {
            openMicrophoneSettings()
            done(microphoneGranted)
        }
    }

    /// Adds the app to the Accessibility list (macOS shows its own prompt) and opens the pane.
    static func requestAccessibility() {
        let prompt = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        _ = AXIsProcessTrustedWithOptions([prompt: true] as CFDictionary)
        openAccessibilitySettings()
    }

    static func openMicrophoneSettings() {
        open("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
    }

    static func openAccessibilitySettings() {
        open("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
    }

    private static func open(_ url: String) {
        if let url = URL(string: url) { NSWorkspace.shared.open(url) }
    }
}
