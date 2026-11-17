import AppKit
import DictateCore
import UserNotifications

/// Native meeting reminders: every 30 seconds, the member's upcoming meetings from the suite's
/// calendar API (asked through the signed-in page, so no other credential is needed), and a
/// notification a minute before each one with attendees or a call link. Clicking it opens the
/// call link (when there is one) and starts taking notes for that meeting in the app's window;
/// "Just take notes" does only the second.
@MainActor
final class Reminders: NSObject, UNUserNotificationCenterDelegate {
    private let suite: SuiteWindow
    private let isEnabled: () -> Bool
    private var planner = ReminderPlanner()
    private var timer: Timer?
    private var running = false
    /// Keeps App Nap from stretching the 30 s check past the 90 s lead while no window is seen.
    private var activity: NSObjectProtocol?
    private static let tick: TimeInterval = 30

    init(suite: SuiteWindow, isEnabled: @escaping () -> Bool) {
        self.suite = suite
        self.isEnabled = isEnabled
        super.init()
    }

    private static let withLink = "meeting-with-link"
    private static let withoutLink = "meeting"
    private static let joinAction = "join"
    private static let notesAction = "notes"

    func start() {
        UNUserNotificationCenter.current().delegate = self
        let join = UNNotificationAction(identifier: Self.joinAction, title: "Join and take notes", options: [.foreground])
        let notes = UNNotificationAction(identifier: Self.notesAction, title: "Just take notes", options: [.foreground])
        UNUserNotificationCenter.current().setNotificationCategories([
            UNNotificationCategory(identifier: Self.withLink, actions: [join, notes], intentIdentifiers: []),
            UNNotificationCategory(identifier: Self.withoutLink, actions: [notes], intentIdentifiers: []),
        ])
        if isEnabled() { requestAuthorization() }
        updateActivity()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: Self.tick, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.check() }
        }
        // Not at once: the page needs a moment to load and sign in.
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in self?.check() }
    }

    /// Asks macOS once; the member can change it later in System Settings → Notifications.
    func requestAuthorization(_ done: ((Bool) -> Void)? = nil) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
            DispatchQueue.main.async { done?(granted) }
        }
    }

    /// Whether macOS lets the app show notifications.
    func authorizationStatus(_ done: @escaping (UNAuthorizationStatus) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let status = settings.authorizationStatus
            DispatchQueue.main.async { done(status) }
        }
    }

    func check() {
        updateActivity()
        guard isEnabled(), !running else { return }
        running = true
        Task { @MainActor in
            defer { running = false }
            let now = Date()
            let format = ISO8601DateFormatter()
            let from = format.string(from: now)
            let to = format.string(from: now.addingTimeInterval(ReminderPlanner.lookahead))
            guard let result = await suite.apiGet("/api/calendar/upcoming?from=\(from)&to=\(to)") else { return }
            UserDefaults.standard.set(result.status, forKey: "status.remindersLastStatus")
            guard result.status == 200, let body = result.body,
                  let meetings = try? UpcomingMeeting.decodeList(body)
            else { return }
            UserDefaults.standard.set(Date(), forKey: "status.remindersLastChecked")
            for meeting in planner.due(meetings, now: now) { notify(meeting) }
            authorizationStatus { UserDefaults.standard.set($0.rawValue, forKey: "status.notificationAuthorization") }
        }
    }

    private func updateActivity() {
        if isEnabled(), activity == nil {
            activity = ProcessInfo.processInfo.beginActivity(options: .userInitiatedAllowingIdleSystemSleep, reason: "Meeting reminders")
        } else if !isEnabled(), let current = activity {
            ProcessInfo.processInfo.endActivity(current)
            activity = nil
        }
    }

    private func notify(_ meeting: UpcomingMeeting) {
        let content = UNMutableNotificationContent()
        content.title = "Take notes for “\(meeting.title)”?"
        content.sound = .default
        if let join = meeting.joinURL {
            content.body = "It starts in about a minute. Click to join the call and take notes."
            content.categoryIdentifier = Self.withLink
            content.userInfo = ["path": meeting.startPath, "join": join.absoluteString]
        } else {
            content.body = "It starts in about a minute. Click to take notes."
            content.categoryIdentifier = Self.withoutLink
            content.userInfo = ["path": meeting.startPath]
        }
        let request = UNNotificationRequest(identifier: "meeting \(ReminderPlanner.key(meeting))", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            let outcome = error.map { "failed: \($0.localizedDescription)" } ?? "posted"
            DispatchQueue.main.async {
                UserDefaults.standard.set("\(outcome) \(meeting.id) at \(ISO8601DateFormatter().string(from: Date()))", forKey: "status.remindersLastPosted")
            }
        }
    }

    // MARK: UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        // Shown even while the app is in front.
        completionHandler([.banner, .list, .sound])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let path = info["path"] as? String
        // A click on the notice itself joins too; "Just take notes" doesn't.
        let joins = response.actionIdentifier != Self.notesAction
        let join = joins ? (info["join"] as? String).flatMap(URL.init(string:)) : nil
        DispatchQueue.main.async { [weak self] in
            guard let self else { return completionHandler() }
            self.suite.show()
            if let path { self.suite.open(path: path) }
            // The call opens last, so its window (browser, Zoom, Teams) ends up in front.
            if let join {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { NSWorkspace.shared.open(join) }
            }
            completionHandler()
        }
    }
}
