import Foundation

/// Call detection (docs/PLAN-record-any-call.md, slice 4; docs/PLAN-granola-calls.md). When a call
/// app (Zoom, Teams, Slack, FaceTime, or a browser on Google Meet...) holds the microphone for a few
/// seconds and no meeting is recording, the app offers "Meeting detected · Take notes" once for that call.
/// When the app lets go and a meeting that started during the call is recording, the page is told
/// the call ended and stops after its own countdown. A recording already running when the call
/// began is never stopped for it. Nothing here ever starts a recording.
public struct CallWatch: Sendable {
    /// A brief grab (a voice memo, a sound check) isn't a call.
    public static let startAfter: TimeInterval = 4
    /// While a call is starting, the app can let go of the mic for a moment (joining muted, a
    /// device switch, Core Audio between two reads); only a longer gap means it wasn't a call.
    /// Two missed 2 s ticks (or four 1 s ticks) are tolerated; 5, not 4, because a real timer runs a little late.
    public static let startGap: TimeInterval = 5
    /// Calls drop the mic for a moment when devices change; that isn't the end.
    public static let endAfter: TimeInterval = 20
    /// "The call ended" only follows a call that lasted this long.
    public static let minimumCall: TimeInterval = 60
    /// The same app isn't offered again this soon (a long mute can look like a new call).
    public static let offerCooldown: TimeInterval = 10 * 60

    public enum Action: Equatable, Sendable {
        /// Offer to take notes; `app` is the name of the app on the call.
        case offerNotes(app: String)
        /// The call that recording `session` started during has ended.
        case callEnded(session: String)
        /// A call ended with nothing to stop: withdraw the offer.
        case callOver
        /// A call began but no offer was made, and why (so a missed offer can be explained).
        case skipped(app: String, reason: SkipReason)
    }

    public enum SkipReason: String, Equatable, Sendable {
        /// A meeting was already recording in this app.
        case recording
        /// The same app was offered less than `offerCooldown` ago.
        case cooldown
    }

    enum Phase: Equatable, Sendable {
        case idle
        /// `lastSeen` is the latest tick the app held the mic; `since` stays the first.
        case starting(since: Date, lastSeen: Date, app: String)
        /// `before` was already recording when the call began, and is never stopped for it;
        /// `during` is the latest recording that started during the call.
        case inCall(began: Date, before: String?, during: String?)
        case ending(since: Date, began: Date, before: String?, during: String?)
    }

    private(set) var phase: Phase = .idle
    private var offered: [String: Date] = [:]

    public init() {}

    /// Whether no call is starting or under way.
    public var isIdle: Bool { phase == .idle }

    /// Called every second or two. `micApp` names a call app using the mic, or is nil;
    /// `recording` is the id of the meeting recording in this app (paused counts), or nil.
    /// `sure` says the app is certainly on a call (Zoom, or a browser showing Google Meet): the
    /// offer comes at once instead of after `startAfter`, like Granola's (Nov 24).
    public mutating func update(micApp: String?, recording: String?, now: Date, sure: Bool = false) -> Action? {
        switch phase {
        case .idle:
            guard let micApp else { return nil }
            phase = .starting(since: now, lastSeen: now, app: micApp)
            return sure ? update(micApp: micApp, recording: recording, now: now, sure: true) : nil
        case .starting(let since, let lastSeen, let first):
            guard let micApp else {
                if now.timeIntervalSince(lastSeen) > Self.startGap { phase = .idle }
                return nil
            }
            // Once sure, the call takes its surer name ("Google Meet", not "Google Chrome").
            let app = sure ? micApp : first
            phase = .starting(since: since, lastSeen: now, app: app)
            guard sure || now.timeIntervalSince(since) >= Self.startAfter else { return nil }
            phase = .inCall(began: since, before: recording, during: nil)
            guard recording == nil else { return .skipped(app: app, reason: .recording) }
            if let last = offered[app], now.timeIntervalSince(last) < Self.offerCooldown {
                return .skipped(app: app, reason: .cooldown)
            }
            offered[app] = now
            return .offerNotes(app: app)
        case .inCall(let began, let before, let during):
            let during = Self.during(recording, before: before, during: during)
            phase = micApp == nil
                ? .ending(since: now, began: began, before: before, during: during)
                : .inCall(began: began, before: before, during: during)
            return nil
        case .ending(let since, let began, let before, let during):
            let during = Self.during(recording, before: before, during: during)
            if micApp != nil {
                phase = .inCall(began: began, before: before, during: during)
                return nil
            }
            guard now.timeIntervalSince(since) >= Self.endAfter else {
                phase = .ending(since: since, began: began, before: before, during: during)
                return nil
            }
            phase = .idle
            if let during, recording == during, since.timeIntervalSince(began) >= Self.minimumCall {
                return .callEnded(session: during)
            }
            return .callOver
        }
    }

    private static func during(_ recording: String?, before: String?, during: String?) -> String? {
        guard let recording, recording != before else { return during }
        return recording
    }
}

/// Which microphone users count as a call.
public enum MicApps {
    /// Apps people take calls in. A list, not "any app with the mic": on a real Mac the mic is
    /// also held by Siri, dictation tools and AI apps' voice modes, which aren't calls. Browsers
    /// count too (`browsers`): a Google Meet in Chrome is a call like any other (Nov 23).
    static let callApps: Set<String> = [
        "us.zoom.xos", "com.microsoft.teams2", "com.microsoft.teams", "com.tinyspeck.slackmacgap",
        "com.apple.facetime", "com.cisco.webexmeetingsapp", "cisco-systems.spark", "com.webex.meetingmanager",
        "com.hnc.discord", "net.whatsapp.whatsapp", "desktop.whatsapp", "ru.keepcoder.telegram",
        "org.telegram.desktop", "org.whispersystems.signal-desktop", "com.skype.skype",
        "com.logmein.gotomeeting", "com.ringcentral.glip", "com.ringcentral.ringcentralformac",
        "app.tuple.app", "com.bluejeans.app.bluejeans", "com.amazon.chime", "com.dialpad.dialpad",
        // FaceTime and iPhone calls on the Mac run their audio here.
        "com.apple.avconferenced",
    ]

    /// Browsers whose mic use counts as a call: Meet, Teams or Zoom on the web, named from the
    /// window's title (`callName`). Safari isn't here: its mic runs in WebKit's shared process,
    /// which this app's own window uses too, so the two can't be told apart.
    static let browsers: Set<String> = [
        "com.google.chrome", "com.google.chrome.beta", "com.google.chrome.dev", "com.google.chrome.canary",
        "company.thebrowser.browser", "company.thebrowser.dia", "com.microsoft.edgemac",
        "com.microsoft.edgemac.beta", "com.brave.browser", "org.mozilla.firefox",
        "org.mozilla.firefoxdeveloperedition", "com.vivaldi.vivaldi", "com.operasoftware.opera",
        "org.chromium.chromium",
    ]

    /// Whether this bundle ID (or a helper of it) is a browser.
    public static func isBrowser(_ bundleID: String?) -> Bool {
        guard let bundleID, !bundleID.isEmpty else { return false }
        let main = mainBundleID(bundleID).lowercased()
        // A site installed as a Chrome app (Meet, Teams) runs as com.google.Chrome.app.<id>.
        return browsers.contains(main) || main.hasPrefix("com.google.chrome.app.")
    }

    /// What to call a browser call, from the titles of the browser's windows (each shows its
    /// front tab, e.g. "Meet - abc-defg-hij 🔊"): the call service when one is recognised,
    /// otherwise the browser's own name.
    public static func callName(windowTitles: [String], browser: String) -> String {
        let services: [(name: String, matches: (String) -> Bool)] = [
            ("Google Meet", { $0.hasPrefix("meet - ") || $0.contains("google meet") || $0.contains("meet.google.com") }),
            ("Microsoft Teams", { $0.contains("microsoft teams") || $0.contains("| teams") }),
            ("Zoom", { $0.contains("zoom meeting") || $0.contains("zoom workplace") || $0.contains("app.zoom.us") }),
            ("Webex", { $0.contains("webex") }),
            ("Whereby", { $0.contains("whereby") }),
            ("Slack", { $0.contains("huddle") && $0.contains("slack") }),
            ("Discord", { $0.contains("discord") }),
        ]
        let titles = windowTitles.map { $0.lowercased() }
        for service in services where titles.contains(where: service.matches) {
            return service.name
        }
        return browser
    }

    /// The app a bundle ID belongs to: a helper process (`com.tinyspeck.slackmacgap.helper`)
    /// counts as its app.
    public static func mainBundleID(_ bundleID: String) -> String {
        if let range = bundleID.range(of: ".helper", options: .caseInsensitive) {
            return String(bundleID[..<range.lowerBound])
        }
        return bundleID
    }

    /// Whether a process with this bundle ID using the mic is a call app (or one of its helpers).
    public static func isCallCandidate(_ bundleID: String?, ownBundleID: String?) -> Bool {
        guard let bundleID, !bundleID.isEmpty else { return false }
        let main = mainBundleID(bundleID).lowercased()
        if let own = ownBundleID?.lowercased(), main == own { return false }
        return callApps.contains(main) || isBrowser(main)
    }

    /// Start, from a call, in the app's window: "Any app on this Mac", titled for that app.
    public static func startPath(app: String) -> String {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&=+#?/")
        return "/meetings/start?via=mac-call&app=" + (app.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")
    }
}
