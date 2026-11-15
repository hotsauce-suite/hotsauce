import AppKit
import DictateCore
import UserNotifications

/// Native meeting reminders: every 30 seconds, the member's upcoming meetings from the suite's
/// calendar API (asked through the signed-in page, so no other credential is needed), and a
/// notification a minute before each one with attendees. Clicking it opens Start for that meeting
/// in the app's window, as the web push reminder does in a browser.
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

    func start() {
        UNUserNotificationCenter.current().delegate = self
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
        content.body = "It starts in about a minute."
        content.sound = .default
        content.userInfo = ["path": meeting.startPath]
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
        let path = response.notification.request.content.userInfo["path"] as? String
        DispatchQueue.main.async { [weak self] in
            guard let self else { return completionHandler() }
            self.suite.show()
            if let path { self.suite.open(path: path) }
            completionHandler()
        }
    }
}
