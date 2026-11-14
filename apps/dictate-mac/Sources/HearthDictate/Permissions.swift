import AppKit
import ApplicationServices
import AVFoundation
import CoreLocation
import UserNotifications

/// Microphone, Accessibility, Location and Notifications: what the app needs, and the System
/// Settings panes for them. Checked at every launch (`PermissionCheck`).
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

    /// Read-only: only reports the status. Asking goes through the window's `LocationService`,
    /// which knows how to make macOS show its prompt.
    private static let locationManager = CLLocationManager()

    /// Allowed for this app. Location Services being off for the whole Mac is checked separately
    /// (`locationServicesOn`), since that call can stall the main thread.
    static var locationAllowed: Bool {
        // As `LocationService` reads it: anything but undecided or refused is allowed.
        switch locationManager.authorizationStatus {
        case .notDetermined, .denied, .restricted: return false
        default: return true
        }
    }

    /// Location Services for the whole Mac, read off the main thread.
    static func locationServicesOn(_ done: @escaping (Bool) -> Void) {
        DispatchQueue.global(qos: .utility).async {
            let on = CLLocationManager.locationServicesEnabled()
            DispatchQueue.main.async { done(on) }
        }
    }

    /// Whether macOS lets the app show notifications (allowed, or quietly allowed).
    static func notificationsAllowed(_ done: @escaping (Bool) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let allowed = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
            DispatchQueue.main.async { done(allowed) }
        }
    }

    /// The first time, macOS's own prompt; after a refusal, the app's page in Notifications settings.
    static func requestNotifications(_ done: @escaping (Bool) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let undecided = settings.authorizationStatus == .notDetermined
            DispatchQueue.main.async {
                guard undecided else {
                    openNotificationSettings()
                    notificationsAllowed(done)
                    return
                }
                UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
                    DispatchQueue.main.async { done(granted) }
                }
            }
        }
    }

    static func openNotificationSettings() {
        open("x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(Bundle.main.bundleIdentifier ?? "")")
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
