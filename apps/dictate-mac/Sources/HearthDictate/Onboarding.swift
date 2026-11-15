import AppKit
import AVFoundation
import DictateCore
import SwiftUI

/// The setup window, one step at a time (docs/PLAN-mac-onboarding.md R10-R12): Workspace, Sign in,
/// Dictate, Permissions, Done. It opens at the first step that isn't finished: on a first run, on a
/// Mac with no workspace or not signed in, and on every launch while a permission is missing.
final class OnboardingModel: ObservableObject {
    @Published var step: SetupFlow.Step = .workspace
    /// Steps skipped in this window (Dictate, Permissions); asked again next launch.
    @Published var skipped: Set<SetupFlow.Step> = []
    /// Settings → Run setup again: Continue visits every step, finished ones too
    /// (docs/PLAN-replay-setup.md R1-R2). Ends when the window closes or opens any other way.
    @Published var replaying = false
    @Published var signedIn = false
    var isSignedIn: () -> Bool = { false }
    /// Done's button: the suite's window, at Today.
    var openSuite: () -> Void = {}

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
    /// The address came from a link (any web page can open one): say so, and Return doesn't continue.
    @Published var filledFromLink = false
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
    /// The practice box: one dictation lands here, so the member sees it work (R9).
    @Published var practice = ""
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
        let wasSignedIn = signedIn
        signedIn = isSignedIn()
        // Signing in happens in the browser and the app's window: move on when it lands.
        if step == .signIn, signedIn, !wasSignedIn { step = SetupFlow.next(after: .signIn, flowState, replaying: replaying) }
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

    var missingPermissions: [PermissionCheck.Item] {
        PermissionCheck.missing(PermissionCheck.Snapshot(
            microphone: microphone, accessibility: accessibility, location: location,
            notifications: notifications, notificationsNeeded: notificationsNeeded
        ))
    }

    var flowState: SetupFlow.State {
        SetupFlow.State(hasWorkspace: workspace() != nil, signedIn: signedIn, dictateConnected: connected,
                        missingPermissions: missingPermissions, skipped: skipped)
    }

    /// Where the window opens: the first unfinished step, or Permissions when everything is done
    /// (the menu's Check Permissions…).
    func openAtFirstUnfinished() {
        replaying = false
        refresh()
        let first = SetupFlow.firstUnfinished(flowState)
        step = first == .done ? .permissions : first
        if step == .workspace, workspace() == nil { beginWorkspace() }
    }

    /// Continue: on to the next step that needs the member; Skip marks this one skipped first.
    func advance(skipping: Bool = false) {
        if skipping { skipped.insert(step) }
        step = SetupFlow.next(after: step, flowState, replaying: replaying)
    }

    /// Run setup again: from step 1, touching nothing that's set up (R1, R3). A Mac with no
    /// workspace yet gets the field to fill, as on a first run.
    func beginReplay() {
        refresh()
        skipped = []
        replaying = true
        editingWorkspace = false
        workspaceError = nil
        workspaceFound = nil
        filledFromLink = false
        step = .workspace
        if workspace() == nil { beginWorkspace() }
    }

    func back() {
        guard let previous = SetupFlow.Step(rawValue: step.rawValue - 1) else { return }
        step = previous
    }

    /// Opens the Workspace step, filled with `address` (a setup link's) or the one this Mac uses now.
    func beginWorkspace(address: URL? = nil) {
        step = .workspace
        editingWorkspace = true
        filledFromLink = address != nil
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
            // The field changed while it was checking (a setup link arrived): that address waits for Continue.
            guard Workspace.origin(fromInput: self.workspaceText) == origin else { return }
            guard case let .found(info) = result else {
                self.workspaceError = result.message(for: origin)
                return
            }
            self.saveWorkspace(info.server)
            self.workspaceText = Workspace.displayAddress(info.server)
            self.workspaceFound = info.summary
            self.offerSignIn = !info.setupRequired
            self.filledFromLink = false
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
        model.replaying = false
        model.beginWorkspace(address: address)
        show(atFirstUnfinished: false)
    }

    /// Opens the window at `step` (Check Permissions…).
    func show(at step: SetupFlow.Step) {
        model.replaying = false
        model.refresh()
        model.step = step
        show(atFirstUnfinished: false)
    }

    /// Settings → Run setup again (and the menus' Run Setup Again…): the whole setup from step 1,
    /// even when the window is already open (docs/PLAN-replay-setup.md R1).
    func replay() {
        model.beginReplay()
        show(atFirstUnfinished: false)
    }

    /// Opens the window; a closed one opens at its first unfinished step (R11). One already open
    /// stays on its step: it's only brought forward.
    func show(atFirstUnfinished: Bool = true) {
        if atFirstUnfinished, !isVisible { model.openAtFirstUnfinished() }
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
        model.replaying = false
        // A half-finished address change doesn't come back next time.
        model.editingWorkspace = false
        model.filledFromLink = false
        model.workspaceError = nil
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
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Header(step: model.step)
                    content
                }
                .padding(24)
            }
            Divider()
            footer.padding(.horizontal, 24).padding(.vertical, 14)
        }
        .frame(width: 500, height: Self.height)
    }

    @ViewBuilder private var content: some View {
        switch model.step {
        case .workspace:
            if model.editingWorkspace || model.workspace() == nil {
                WorkspaceStep(model: model)
            } else {
                WorkspaceFound(model: model, summary: model.workspaceFound
                    ?? "This Mac opens \(Brand.name) at this address. Change it if your team moved.")
            }
        case .signIn:
            SignInStep(model: model)
        case .dictate:
            DictateStep(model: model)
        case .permissions:
            PermissionsStep(model: model)
        case .done:
            DoneStep(model: model)
        }
    }

    private var footer: some View {
        let state = model.flowState
        let finished = SetupFlow.isFinished(model.step, state)
        return HStack(spacing: 10) {
            if model.step != .workspace, model.step != .done {
                Button("Back") { model.back() }
            }
            Spacer()
            switch model.step {
            case .workspace:
                // The step's own Continue checks the address; this one moves on once it's saved.
                if !model.editingWorkspace, model.workspace() != nil {
                    Button("Continue") { model.advance() }.keyboardShortcut(.defaultAction)
                }
            case .done:
                Button("Close", action: done)
                Button("Open \(Brand.name)") {
                    model.openSuite()
                    done()
                }
                .keyboardShortcut(.defaultAction)
            default:
                if model.step.canSkip, !finished {
                    Button("Skip for now") { model.advance(skipping: true) }
                }
                Button("Continue") { model.advance() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!SetupFlow.canLeave(model.step, state) || (!finished && model.step.canSkip))
            }
        }
    }
}

/// "Step 2 of 4 · Sign in" over the window's title.
private struct Header: View {
    let step: SetupFlow.Step

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let number = step.number {
                Text("Step \(number) of \(SetupFlow.Step.counted) · \(step.title)")
                    .font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                    .textCase(.uppercase)
            }
            Text(headline).font(.system(size: 22, weight: .semibold, design: .serif))
            Text(lede).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }

    private var headline: String {
        switch step {
        case .workspace: return "Set up \(Brand.name)"
        case .signIn: return "Sign in"
        case .dictate: return "Dictate"
        case .permissions: return "Permissions"
        case .done: return "You’re all set"
        }
    }

    private var lede: String {
        switch step {
        case .workspace: return "First, your team’s workspace."
        case .signIn: return "Sign in with your Google account. Your browser opens to confirm it’s you, then brings you back here."
        case .dictate: return "Hold a key, speak, and the text lands wherever your cursor is."
        case .permissions: return "\(Brand.name) needs these on this Mac. This window opens each time the app starts until every one is on."
        case .done: return "\(Brand.name) is ready on this Mac. Go through these steps again any time from Settings → Run setup again, or check permissions from \(Brand.name) → Check Permissions…"
        }
    }
}

/// Sign in with Google, through the browser (R7).
private struct SignInStep: View {
    @ObservedObject var model: OnboardingModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if model.signedIn {
                Label("Signed in.", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
            } else {
                Button {
                    model.signIn()
                } label: {
                    Text("Sign in with Google").frame(minWidth: 180)
                }
                .controlSize(.large)
                Text("Signing in also connects Dictate on this Mac.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color(nsColor: .separatorColor)))
    }
}

/// Dictate's connection, a practice box, and the code path (R9).
private struct DictateStep: View {
    @ObservedObject var model: OnboardingModel

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(spacing: 0) {
                Row(
                    title: "Dictate",
                    detail: model.connectedAs.map { "Connected as \($0)." } ?? "Not connected yet. Signing in connects it, or press Connect this Mac on your workspace’s Dictate page.",
                    granted: model.connected,
                    button: "Open Dictate page"
                ) {
                    model.awaiting = .connect
                    model.openDictatePage()
                }
            }
            .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color(nsColor: .separatorColor)))
            if model.connected && model.listening {
                PracticeBox(model: model)
            } else if model.connected {
                Text("Try it once Accessibility is on (next step).").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(model.connected ? "Connect with a code instead" : "Or connect with a code").font(.system(size: 12, weight: .semibold))
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
    }
}

/// Microphone, Accessibility, Location, Notifications, with live checks (R10, PLAN-mac-permissions).
private struct PermissionsStep: View {
    @ObservedObject var model: OnboardingModel

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
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
            }
            .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color(nsColor: .separatorColor)))
            StatusBanner(model: model)
        }
    }
}

/// The end: try it, and where things are.
private struct DoneStep: View {
    @ObservedObject var model: OnboardingModel

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if model.connected && model.listening { PracticeBox(model: model) }
            let stillSkipped = model.skipped.filter { !SetupFlow.isFinished($0, model.flowState) }
            if !stillSkipped.isEmpty {
                Text("You skipped \(stillSkipped.sorted { $0.rawValue < $1.rawValue }.map(\.title).joined(separator: " and ")). This window asks again next time the app starts.")
                    .font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if model.menuBarHidden { MenuBarHint() }
        }
    }
}

/// Try Dictate right here: click in the box, hold the key, speak, let go (R9).
private struct PracticeBox: View {
    @ObservedObject var model: OnboardingModel

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Try it").font(.system(size: 12, weight: .semibold))
            Text("Click in the box, hold \(model.hotkeyName()), say something, and let go.")
                .font(.system(size: 12)).foregroundStyle(.secondary)
            TextEditor(text: $model.practice)
                .font(.system(size: 13))
                .frame(height: 56)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(nsColor: .separatorColor)))
        }
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
                    .onSubmit { if !model.filledFromLink { model.submitWorkspace() } }
                    .disabled(model.checkingWorkspace)
                if model.checkingWorkspace { ProgressView().controlSize(.small) }
                let continueOff = model.checkingWorkspace || model.workspaceText.trimmingCharacters(in: .whitespaces).isEmpty
                if model.filledFromLink {
                    // A link-filled address needs a deliberate click, not a stray Return.
                    Button("Continue") { model.submitWorkspace() }.disabled(continueOff)
                } else {
                    Button("Continue") { model.submitWorkspace() }
                        .keyboardShortcut(.defaultAction)
                        .disabled(continueOff)
                }
                if model.workspace() != nil {
                    Button("Cancel") { model.editingWorkspace = false }.disabled(model.checkingWorkspace)
                }
            }
            if model.filledFromLink, model.workspaceError == nil {
                Text("Filled in from a setup link. Only continue if this is your team’s address.")
                    .font(.system(size: 11)).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
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
            Button("Change") { model.beginWorkspace() }
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
    private var done: Bool { model.permissionsGranted && model.listening && !model.outsideApplications }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: done ? "checkmark.seal.fill" : "info.circle.fill")
                .foregroundStyle(done ? Color.green : Color.orange)
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
        return "All set. Hold \(model.hotkeyName()), speak, and let go. The mic icon in the menu bar has your recent dictations; on a MacBook it can hide behind the camera notch."
    }
}
