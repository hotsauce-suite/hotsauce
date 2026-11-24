import AppKit
import ApplicationServices
import CoreAudio
import DictateCore
import UserNotifications

/// "Meeting detected · Take notes" when a call starts, and "the call ended" while one is recording
/// (docs/PLAN-record-any-call.md, slice 4). Every second it asks Core Audio which other apps are
/// using the microphone; `CallWatch` decides. It only offers: nothing records until the member
/// starts a meeting.
@available(macOS 14.2, *)
@MainActor
final class CallDetector {
    private let suite: SuiteWindow
    private let reminders: Reminders
    private let isEnabled: () -> Bool
    private var watch = CallWatch()
    /// The app on the current call, for the decision log: when a call ends no app holds the mic.
    private var callApp: String?
    private var timer: Timer?
    private let offer = CallOffer()
    /// Every second, so a call is offered about as soon as it takes the mic.
    private static let tick: TimeInterval = 1

    init(suite: SuiteWindow, reminders: Reminders, isEnabled: @escaping () -> Bool) {
        self.suite = suite
        self.reminders = reminders
        self.isEnabled = isEnabled
    }

    func start() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: Self.tick, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.check() }
        }
    }

    func check() {
        guard isEnabled() else {
            watch = CallWatch()
            offer.hide()
            return
        }
        // While no call is under way, a browser's window titles are read fresh, so a Meet tab
        // that just opened is recognised on the tick its mic starts.
        let call = Self.callUsingMic(Self.micUsers(), fresh: watch.isIdle)
        let action = watch.update(micApp: call?.name, recording: suite.recordingMeetingSession, now: Date(), sure: call?.sure ?? false)
        switch action {
        case .offerNotes(let name):
            callApp = name
            if let meeting = reminders.remindedMeeting(at: Date()) {
                // The calendar reminder for this meeting goes; one offer, named for the meeting.
                reminders.withdraw(meeting)
                record(name, "offered for “\(meeting.title)”")
                offerNotes(title: meeting.title, app: name, path: meeting.callStartPath(app: name))
            } else {
                record(name, "offered")
                offerNotes(title: "Meeting detected", app: name, path: MicApps.startPath(app: name))
            }
        case .callEnded(let session):
            record(callApp, "call ended while recording")
            withdrawOffer()
            suite.meetingCallEnded(session: session)
            notify(id: "call-end", title: "The call ended",
                   body: "\(Brand.name) stops taking notes in 30 seconds. Open \(Brand.name) to keep recording.",
                   path: nil, app: callApp)
        case .callOver:
            record(callApp, "call ended")
            withdrawOffer()
        case .skipped(let name, .recording):
            callApp = name
            // Already taking notes: the meeting's reminder has nothing left to offer.
            if let meeting = reminders.remindedMeeting(at: Date()) { reminders.withdraw(meeting) }
            record(name, "not offered: a meeting was already recording")
        case .skipped(let name, .cooldown):
            callApp = name
            record(name, "not offered: offered for this app in the last 10 minutes")
        case nil:
            break
        }
    }

    /// The latest call decision, so `defaults read <bundle id> status.callLastDecision` explains a
    /// missed offer: "<ISO time> <app> <decision>".
    nonisolated static let decisionKey = "status.callLastDecision"

    private func record(_ app: String?, _ decision: String) {
        let line = "\(ISO8601DateFormatter().string(from: Date())) \(app ?? "call") \(decision)"
        UserDefaults.standard.set(line, forKey: Self.decisionKey)
    }

    /// "Meeting detected" with one button, like Granola's (docs/PLAN-granola-calls.md): Take notes
    /// opens the meeting, which starts listening to the mic and the Mac's sound at once.
    private func offerNotes(title: String, app: String, path: String) {
        offer.show(title: title, app: app) { [weak self] in
            guard let self else { return }
            self.record(app, "take notes pressed")
            self.suite.show()
            self.suite.open(path: path)
        }
    }

    /// An offer left up after its call ended would start listening later.
    private func withdrawOffer() {
        offer.hide()
    }

    /// Shown through the meeting reminders' notification delegate, which opens `path` on click.
    private func notify(id: String, title: String, body: String, path: String?, app: String?) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, error in
            guard granted else {
                let reason = error.map { ": \($0.localizedDescription)" } ?? ""
                Task { @MainActor in self.record(app, "notification refused by macOS\(reason)") }
                return
            }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            if let path { content.userInfo = ["path": path] }
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
        }
    }

    // MARK: Core Audio

    /// A process using the microphone, as Core Audio reports it.
    struct MicUser {
        let pid: pid_t
        let bundleID: String?
    }

    /// Every process with its input running.
    static func micUsers() -> [MicUser] {
        processObjects().compactMap { process in
            guard (uint32(process, kAudioProcessPropertyIsRunningInput) ?? 0) != 0 else { return nil }
            let pid = pid_t(bitPattern: uint32(process, kAudioProcessPropertyPID) ?? 0)
            return MicUser(pid: pid, bundleID: string(process, kAudioProcessPropertyBundleID))
        }
    }

    /// The name of another app in `users` (one Core Audio snapshot) that could be on a call, or nil.
    static func callAppUsingMic(_ users: [MicUser]) -> String? {
        callUsingMic(users, fresh: false)?.name
    }

    /// The call in `users`, and whether it surely is one: a call app, or a browser whose window
    /// shows a call service. A browser on some other site is a call only once it has held the mic
    /// for a few seconds. A sure call comes first when several apps hold the mic.
    static func callUsingMic(_ users: [MicUser], fresh: Bool) -> (name: String, sure: Bool)? {
        let own = Bundle.main.bundleIdentifier
        let ownPID = ProcessInfo.processInfo.processIdentifier
        var unsure: String?
        for user in users where user.pid != ownPID {
            guard MicApps.isCallCandidate(user.bundleID, ownBundleID: own),
                  let call = call(of: user, fresh: fresh) else { continue }
            if call.sure { return call }
            unsure = unsure ?? call.name
        }
        return unsure.map { ($0, false) }
    }

    /// The app with a Dock icon behind a process (itself, or the app a helper belongs to). Drivers,
    /// agents and background services have none and never count as a call.
    static func appName(of user: MicUser) -> String? {
        call(of: user, fresh: false)?.name
    }

    private static func call(of user: MicUser, fresh: Bool) -> (name: String, sure: Bool)? {
        // FaceTime and iPhone calls: the audio runs in a background service, not the FaceTime app.
        if user.bundleID == "com.apple.avconferenced" { return ("FaceTime", true) }
        var candidates: [NSRunningApplication] = []
        if let bundleID = user.bundleID {
            candidates += NSRunningApplication.runningApplications(withBundleIdentifier: MicApps.mainBundleID(bundleID))
        }
        if let app = NSRunningApplication(processIdentifier: user.pid) { candidates.append(app) }
        guard let app = candidates.first(where: { $0.activationPolicy == .regular }),
              let name = app.localizedName else { return nil }
        // A call in a browser is named for the service in its window ("Google Meet").
        guard MicApps.isBrowser(user.bundleID) else { return (name, true) }
        let service = MicApps.callName(windowTitles: windowTitles(of: app.processIdentifier, fresh: fresh), browser: name)
        return (service, service != name)
    }

    /// The titles of an app's windows (each browser window shows its front tab's title), read
    /// through Accessibility, which Dictate already has. Without it: none, and the browser's name.
    static func windowTitles(of pid: pid_t, fresh: Bool = false) -> [String] {
        // During a call, read at most every 30 s per app: detection runs every second on the main
        // thread, and a busy browser can be slow to answer. Before one, `fresh` reads every time.
        if !fresh, let cached = titleCache, cached.pid == pid, Date().timeIntervalSince(cached.at) < 30 { return cached.titles }
        let titles = readWindowTitles(of: pid)
        titleCache = (pid, Date(), titles)
        return titles
    }

    private static var titleCache: (pid: pid_t, at: Date, titles: [String])?

    private static func readWindowTitles(of pid: pid_t) -> [String] {
        guard AXIsProcessTrusted() else { return [] }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.25)
        var windows: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &windows) == .success,
              let list = windows as? [AXUIElement] else { return [] }
        return list.prefix(20).compactMap { window in
            AXUIElementSetMessagingTimeout(window, 0.25)
            var title: CFTypeRef?
            guard AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &title) == .success else { return nil }
            return title as? String
        }
    }

    private static func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    }

    private static func processObjects() -> [AudioObjectID] {
        var address = address(kAudioHardwarePropertyProcessObjectList)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr, size > 0 else { return [] }
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else { return [] }
        return ids
    }

    private static func uint32(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
        var address = address(selector)
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr ? value : nil
    }

    private static func string(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
        var address = address(selector)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr, let value else { return nil }
        return value.takeRetainedValue() as String
    }
}
