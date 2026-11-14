import AppKit
import AVFoundation
import DictateCore
import SwiftUI

/// The setup window: the workspace's address on a Mac that has none, then Microphone,
/// Accessibility, Location, Notifications and Connect, each with a live check. It opens on the
/// first launch and on every launch while a permission is missing.
final class OnboardingModel: ObservableObject {
    // The Workspace step (docs/PLAN-mac-onboarding.md R1-R3).
    /// The step shows while this Mac has no workspace, or the member asked to change it.
    @Published var editingWorkspace = false
    @Published var workspaceText = ""
    @Published var checkingWorkspace = false
    @Published var workspaceError: String?
    /// What the server said about itself, after Continue found it ("Acme. Sign in with…").
    @Published var workspaceFound: String?
    /// Offered once a workspace is saved here, so its window can be signed in.
    @Published var offerSignIn = false
    var workspace: () -> URL? = { nil }
    var saveWorkspace: (URL) -> Void = { _ in }
    var signIn: () -> Void = {}
    /// The check, replaceable in previews.
    var checkWorkspace: (URL) async -> Workspace.CheckResult = { await Workspace.check($0, fetch: Workspace.networkFetch) }

    @Published var microphone = Permissions.microphoneGranted
    @Published var accessibility = Permissions.accessibilityGranted
    @Published var location = Permissions.locationAllowed
    @Published var notifications = true
    /// False when nothing in Settings shows notifications; then the row is hidden.
    @Published var notificationsNeeded = true
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
    var requestLocation: () -> Void = {}
    var needsNotifications: () -> Bool = { true }
    /// Called when a step turns green after this window sent the member to System Settings or the
    /// browser, so the window comes back; never otherwise, so it can't take focus mid-work.
    var stepCompleted: () -> Void = {}
    /// The row whose button sent the member elsewhere to finish it. Only that row turning green
    /// brings the window back, so another one (macOS's own notification prompt) can't pull it
    /// over System Settings mid-step.
    enum Step { case microphone, accessibility, location, notifications, connect }
    var awaiting: Step?
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

    /// Location Services for the whole Mac, as last read (that read happens off the main thread).
    private var locationServicesOn = true

    /// Everything macOS says right now, then `done` on the main thread: the launch check.
    static func snapshot(notificationsNeeded: Bool, _ done: @escaping (PermissionCheck.Snapshot) -> Void) {
        Permissions.locationServicesOn { servicesOn in
            Permissions.notificationsAllowed { notificationsOn in
                done(PermissionCheck.Snapshot(
                    microphone: Permissions.microphoneGranted,
                    accessibility: Permissions.accessibilityGranted,
                    location: servicesOn && Permissions.locationAllowed,
                    notifications: notificationsOn,
                    notificationsNeeded: notificationsNeeded
                ))
            }
        }
    }

    func refresh() {
        let before = (microphone, accessibility, connected, listening, location, notifications)
        microphone = Permissions.microphoneGranted
        accessibility = Permissions.accessibilityGranted
        notificationsNeeded = needsNotifications()
        setLocation(locationServicesOn && Permissions.locationAllowed)
        // The two slow reads answer a moment later; a step they turn green brings the window back.
        Permissions.locationServicesOn { [weak self] on in
            guard let self else { return }
            self.locationServicesOn = on
            self.setLocation(on && Permissions.locationAllowed)
        }
        Permissions.notificationsAllowed { [weak self] on in self?.setNotifications(on) }
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
        if microphone && !before.0 { stepAdvanced(.microphone) }
        if (accessibility && !before.1) || (listening && !before.3) { stepAdvanced(.accessibility) }
        if connected && !before.2 { stepAdvanced(.connect) }
        if location && !before.4 { stepAdvanced(.location) }
        if notifications && !before.5 { stepAdvanced(.notifications) }
    }

    private func setLocation(_ on: Bool) {
        guard location != on else { return }
        location = on
        if on { stepAdvanced(.location) }
    }

    private func setNotifications(_ on: Bool) {
        guard notifications != on else { return }
        notifications = on
        if on { stepAdvanced(.notifications) }
    }

    private func stepAdvanced(_ step: Step) {
        guard awaiting == step else { return }
        awaiting = nil
        stepCompleted()
    }

    /// Every permission the app needs (not the connection, which isn't a macOS permission).
    var permissionsGranted: Bool {
        PermissionCheck.missing(PermissionCheck.Snapshot(
            microphone: microphone, accessibility: accessibility, location: location,
            notifications: notifications, notificationsNeeded: notificationsNeeded
        )).isEmpty
    }

    var allSet: Bool { permissionsGranted && listening && connected }

    /// Opens the Workspace step, filled with `address` (a setup link's) or the one this Mac uses now.
    func beginWorkspace(address: URL? = nil) {
        editingWorkspace = true
        workspaceText = (address ?? workspace()).map(Workspace.displayAddress) ?? ""
        workspaceError = nil
        workspaceFound = nil
    }

    /// Continue: checks the address is a Hotsauce workspace, then saves it (R2, R3).
    func submitWorkspace() {
        workspaceError = nil
        workspaceFound = nil
        guard let origin = Workspace.origin(fromInput: workspaceText) else {
            workspaceError = "Enter your workspace’s address, like team.example.com."
            return
        }
        checkingWorkspace = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            let result = await self.checkWorkspace(origin)
            self.checkingWorkspace = false
            guard case let .found(info) = result else {
                self.workspaceError = result.message(for: origin)
                return
            }
            self.saveWorkspace(info.server)
            self.workspaceText = Workspace.displayAddress(info.server)
            self.workspaceFound = info.summary
            self.offerSignIn = !info.setupRequired
            self.editingWorkspace = false
        }
    }

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
    /// The setup window at its Workspace step: a Mac with no workspace, or "Change workspace address".
    func showWorkspace(address: URL? = nil) {
        model.beginWorkspace(address: address)
        show()
    }

    func show() {
        if window == nil {
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 500, height: OnboardingView.height),
                styleMask: [.titled, .closable],
                backing: .buffered,
                defer: false
            )
            window.title = "Set up \(Brand.name)"
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
        model.awaiting = nil
        onClose()
    }
}

extension OnboardingWindow {
    /// The setup window's content for `--render-previews`, never shown on screen.
    static func previewView(model: OnboardingModel) -> NSView {
        NSHostingView(rootView: OnboardingView(model: model, done: {}).background(Color(nsColor: .windowBackgroundColor)))
    }
}

private struct OnboardingView: View {
    /// Fits a small screen (a 13-inch MacBook at its default size) under the title bar and Dock.
    static var height: CGFloat { min(720, (NSScreen.main?.visibleFrame.height ?? 800) - 60) }
    @ObservedObject var model: OnboardingModel
    let done: () -> Void

    var body: some View {
        ScrollView {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Set up \(Brand.name)").font(.system(size: 22, weight: .semibold, design: .serif))
                Text(model.workspace() == nil
                    ? "First, your team’s workspace."
                    : "\(Brand.name) needs these to work. This window opens each time the app starts until every one is on.")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if model.editingWorkspace || model.workspace() == nil {
                WorkspaceStep(model: model)
            } else if let found = model.workspaceFound {
                WorkspaceFound(model: model, summary: found)
            }
            if model.workspace() != nil {
            VStack(spacing: 0) {
                Row(
                    title: "Microphone",
                    detail: "To hear you while you hold the key.",
                    granted: model.microphone,
                    button: "Allow"
                ) {
                    model.awaiting = .microphone
                    Permissions.requestMicrophone { _ in model.refresh() }
                }
                Divider()
                Row(
                    title: "Accessibility",
                    detail: "To see the key in every app and paste for you.",
                    granted: model.accessibility,
                    button: "Open Settings"
                ) {
                    model.awaiting = .accessibility
                    Permissions.requestAccessibility()
                }
                Divider()
                Row(
                    title: "Location",
                    detail: "For the weather where you are on Today. Rounded to about a kilometre.",
                    granted: model.location,
                    button: "Allow"
                ) {
                    model.awaiting = .location
                    model.requestLocation()
                }
                if model.notificationsNeeded {
                    Divider()
                    Row(
                        title: "Notifications",
                        detail: "For meeting reminders and the offer to take notes on a call.",
                        granted: model.notifications,
                        button: "Allow"
                    ) {
                        model.awaiting = .notifications
                        Permissions.requestNotifications { _ in model.refresh() }
                    }
                }
                Divider()
                Row(
                    title: "Connect to \(Brand.name)",
                    detail: model.connectedAs.map { "Connected as \($0)." } ?? "Press Connect this Mac on your workspace’s /dictate page.",
                    granted: model.connected,
                    button: "Open \(Brand.name)"
                ) {
                    model.awaiting = .connect
                    model.openDictatePage()
                }
            }
            .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color(nsColor: .separatorColor)))

            StatusBanner(model: model)
            if model.allSet && model.menuBarHidden { MenuBarHint() }
            }

            if model.workspace() != nil {
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
            }
            Spacer(minLength: 0)
            if model.workspace() != nil {
                HStack {
                    Button("Open Dictate in \(Brand.name)") { model.openDictatePage() }
                        .buttonStyle(.link)
                    Spacer()
                }
            }
            HStack {
                Text("Open it again from \(Brand.name) → Check Permissions… or the menu bar icon.")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                Spacer()
                // Return is Continue while the Workspace step shows.
                if model.editingWorkspace || model.workspace() == nil {
                    Button("Done", action: done)
                } else {
                    Button("Done", action: done).keyboardShortcut(.defaultAction)
                }
            }
        }
        .padding(24)
        }
        .frame(width: 500, height: Self.height)
    }
}

/// "Where does your team's Hotsauce live?": one field, checked before it's saved.
private struct WorkspaceStep: View {
    @ObservedObject var model: OnboardingModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Where does your team’s \(Brand.name) live?").font(.system(size: 13, weight: .semibold))
            Text("The address you open \(Brand.name) at in a browser. Ask whoever set it up if you’re not sure.")
                .font(.system(size: 12)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                TextField("team.example.com", text: $model.workspaceText)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { model.submitWorkspace() }
                    .disabled(model.checkingWorkspace)
                if model.checkingWorkspace { ProgressView().controlSize(.small) }
                Button("Continue") { model.submitWorkspace() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(model.checkingWorkspace || model.workspaceText.trimmingCharacters(in: .whitespaces).isEmpty)
                if model.workspace() != nil {
                    Button("Cancel") { model.editingWorkspace = false }.disabled(model.checkingWorkspace)
                }
            }
            if let error = model.workspaceError {
                Text(error).font(.system(size: 11)).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color(nsColor: .separatorColor)))
    }
}

/// The workspace that answered, and the browser sign-in for its window.
private struct WorkspaceFound: View {
    @ObservedObject var model: OnboardingModel
    let summary: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "checkmark.circle.fill").font(.system(size: 18)).foregroundStyle(Color.green)
            VStack(alignment: .leading, spacing: 2) {
                Text(model.workspaceText).font(.system(size: 13, weight: .semibold))
                Text(summary).font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            if model.offerSignIn { Button("Sign in with Google") { model.signIn() } }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color(nsColor: .separatorColor)))
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
            return "Drag \(Brand.name) into your Applications folder and open it from there; permissions given to a copy run from the download don’t stick."
        }
        if !model.microphone { return "Allow the microphone above." }
        if !model.accessibility {
            return "Turn on \(Brand.name) under Accessibility in System Settings (the button above opens it). If it’s already on, an update changed the app: select it, remove it with −, and add it again from Applications."
        }
        if !model.location {
            return "Allow Location above. If macOS doesn’t ask, turn \(Brand.name) on under Location Services in System Settings (the button opens it), and check Location Services itself is on."
        }
        if model.notificationsNeeded, !model.notifications {
            return "Allow Notifications above, or turn them on for \(Brand.name) in System Settings → Notifications."
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
