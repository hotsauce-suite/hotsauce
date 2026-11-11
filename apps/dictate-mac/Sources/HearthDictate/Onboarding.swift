import AppKit
import AVFoundation
import DictateCore
import SwiftUI

/// The first-run window: Microphone, Accessibility, Connect to Hearth, each with a live check.
final class OnboardingModel: ObservableObject {
    @Published var microphone = Permissions.microphoneGranted
    @Published var accessibility = Permissions.accessibilityGranted
    @Published var connected = false
    @Published var connectedAs: String?
    @Published var listening = false
    @Published var code = ""
    @Published var codeError: String?

    /// Connects with a pasted code; calls back with why it didn't, or nil when it did.
    var connect: (String, @escaping (String?) -> Void) -> Void = { _, done in done(nil) }
    var openDictatePage: () -> Void = {}
    var isConnected: () -> Bool = { false }
    var account: () -> String? = { nil }
    var hotkeyReady: () -> Bool = { false }
    var hotkeyName: () -> String = { "" }
    var relaunch: () -> Void = {}
    var startHotkey: () -> Void = {}
    /// Called when a step turns green after this window sent the member to System Settings or the
    /// browser, so the window comes back; never otherwise, so it can't take focus mid-work.
    var stepCompleted: () -> Void = {}
    /// Set when a button here sends the member elsewhere to finish a step.
    var awaitingReturn = false
    var notInApplications: () -> Bool = { false }
    @Published var outsideApplications = false
    @Published var menuBarHidden = false
    var isMenuBarIconHidden: () -> Bool = { false }
    /// When Accessibility was on but the key tap still wasn't, so "quit and reopen" isn't
    /// offered in the second it takes the tap to start.
    private var tapMissingSince: Date?
    @Published var tapStuck = false
    private var timer: Timer?

    func startWatching() {
        refresh()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.refresh() }
    }

    func stopWatching() {
        timer?.invalidate()
        timer = nil
    }

    func refresh() {
        let before = (microphone, accessibility, connected, listening)
        microphone = Permissions.microphoneGranted
        accessibility = Permissions.accessibilityGranted
        connected = isConnected()
        connectedAs = account()
        outsideApplications = notInApplications()
        menuBarHidden = isMenuBarIconHidden()
        if accessibility, !hotkeyReady() { startHotkey() }
        listening = hotkeyReady()
        if accessibility, !listening {
            tapMissingSince = tapMissingSince ?? Date()
            tapStuck = Date().timeIntervalSince(tapMissingSince ?? Date()) > 5
        } else {
            tapMissingSince = nil
            tapStuck = false
        }
        let advanced = (microphone && !before.0) || (accessibility && !before.1) || (connected && !before.2) || (listening && !before.3)
        if advanced, awaitingReturn {
            awaitingReturn = false
            stepCompleted()
        }
    }

    var allSet: Bool { microphone && accessibility && listening && connected }

    func submitCode() {
        codeError = nil
        connect(code) { [weak self] error in
            guard let self else { return }
            self.codeError = error
            if error == nil { self.code = "" }
            self.refresh()
        }
    }
}

final class OnboardingWindow: NSObject, NSWindowDelegate {
    let model = OnboardingModel()
    private var window: NSWindow?
    var onClose: () -> Void = {}

    var isVisible: Bool { window?.isVisible ?? false }
    func show() {
        if window == nil {
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 500, height: 580),
                styleMask: [.titled, .closable],
                backing: .buffered,
                defer: false
            )
            window.title = "Hearth Dictate"
            window.isReleasedWhenClosed = false
            window.delegate = self
            window.contentView = NSHostingView(rootView: OnboardingView(model: model, done: { [weak self] in self?.close() }))
            window.center()
            self.window = window
        }
        model.startWatching()
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        window?.orderFrontRegardless()
    }

    func close() {
        window?.close()
    }

    func windowWillClose(_ notification: Notification) {
        model.stopWatching()
        model.awaitingReturn = false
        onClose()
    }
}

private struct OnboardingView: View {
    @ObservedObject var model: OnboardingModel
    let done: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Set up Hearth Dictate").font(.system(size: 22, weight: .semibold, design: .serif))
                Text("Hold Right Option, speak, and let go: the text appears where your cursor is.")
                    .foregroundStyle(.secondary)
            }
            VStack(spacing: 0) {
                Row(
                    title: "Microphone",
                    detail: "To hear you while you hold the key.",
                    granted: model.microphone,
                    button: "Allow"
                ) {
                    model.awaitingReturn = true
                    Permissions.requestMicrophone { _ in model.refresh() }
                }
                Divider()
                Row(
                    title: "Accessibility",
                    detail: "To see the key in every app and paste for you.",
                    granted: model.accessibility,
                    button: "Open Settings"
                ) {
                    model.awaitingReturn = true
                    Permissions.requestAccessibility()
                }
                Divider()
                Row(
                    title: "Connect to Hearth",
                    detail: model.connectedAs.map { "Connected as \($0)." } ?? "Press Connect this Mac on your workspace’s /dictate page.",
                    granted: model.connected,
                    button: "Open Hearth"
                ) {
                    model.awaitingReturn = true
                    model.openDictatePage()
                }
            }
            .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color(nsColor: .separatorColor)))

            StatusBanner(model: model)
            if model.allSet && model.menuBarHidden { MenuBarHint() }

            VStack(alignment: .leading, spacing: 6) {
                Text("Paste connection code").font(.system(size: 12, weight: .semibold))
                HStack {
                    TextField("hearth-dictate://connect?…", text: $model.code)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { model.submitCode() }
                    Button("Connect") { model.submitCode() }
                        .disabled(model.code.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                if let error = model.codeError {
                    Text(error).font(.system(size: 11)).foregroundStyle(.red)
                }
            }
            Spacer(minLength: 0)
            HStack {
                Button("Open Hearth Dictate on the web") { model.openDictatePage() }
                    .buttonStyle(.link)
                Spacer()
            }
            HStack {
                Text("Open Hearth Dictate again any time to see this window.")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                Spacer()
                Button("Done", action: done).keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 500, height: 580)
    }
}

private struct Row: View {
    let title: String
    let detail: String
    let granted: Bool
    let button: String
    let action: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: granted ? "checkmark.circle.fill" : "circle")
                .font(.system(size: 18))
                .foregroundStyle(granted ? Color.green : Color.secondary)
                .accessibilityLabel(granted ? "Done" : "Not yet")
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 13, weight: .semibold))
                Text(detail).font(.system(size: 12)).foregroundStyle(.secondary)
            }
            Spacer()
            if !granted { Button(button, action: action) }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }
}

/// One line on what to do next, so a missing piece is never silent.
private struct StatusBanner: View {
    @ObservedObject var model: OnboardingModel

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: model.allSet ? "checkmark.seal.fill" : "info.circle.fill")
                .foregroundStyle(model.allSet ? Color.green : Color.orange)
            VStack(alignment: .leading, spacing: 6) {
                Text(message).font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
                if model.tapStuck {
                    Button("Quit and reopen \(Brand.name)") { model.relaunch() }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor).opacity(0.6)))
    }

    private var message: String {
        if model.outsideApplications {
            return "Drag Hearth Dictate into your Applications folder and open it from there; permissions given to a copy run from the download don’t stick."
        }
        if !model.microphone { return "Allow the microphone above." }
        if !model.accessibility {
            return "Turn on \(Brand.name) under Accessibility in System Settings (the button above opens it). If it’s already on, an update changed the app: select it, remove it with −, and add it again from Applications."
        }
        if !model.listening {
            return model.tapStuck
                ? "Accessibility is on, but macOS hasn’t let \(Brand.name) see the keyboard yet. Quit and reopen it."
                : "Starting the keyboard shortcut…"
        }
        if !model.connected { return "Last step: on your workspace’s /dictate page, press Connect this Mac, or paste the code below." }
        return "All set. Hold \(model.hotkeyName()), speak, and let go. The mic icon in the menu bar has your recent dictations; on a MacBook it can hide behind the camera notch."
    }
}
