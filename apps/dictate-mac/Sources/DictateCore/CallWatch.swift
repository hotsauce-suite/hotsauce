import Foundation

/// Call detection (docs/PLAN-record-any-call.md, slice 4). When a call app (Zoom, Teams, Slack,
/// FaceTime...) holds the microphone for a few seconds and no meeting is recording, the app offers "Take notes?" once for that call.
/// When the app lets go and a meeting that started during the call is recording, the page is told
/// the call ended and stops after its own countdown. A recording already running when the call
/// began is never stopped for it. Nothing here ever starts a recording.
public struct CallWatch: Sendable {
    /// A brief grab (a voice memo, a sound check) isn't a call.
    public static let startAfter: TimeInterval = 4
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
    }

    enum Phase: Equatable, Sendable {
        case idle
        case starting(since: Date, app: String)
        /// `before` was already recording when the call began, and is never stopped for it;
        /// `during` is the latest recording that started during the call.
        case inCall(began: Date, before: String?, during: String?)
        case ending(since: Date, began: Date, before: String?, during: String?)
    }

    private(set) var phase: Phase = .idle
    private var offered: [String: Date] = [:]

    public init() {}

    /// Called every couple of seconds. `micApp` names a call app using the mic, or is nil;
    /// `recording` is the id of the meeting recording in this app (paused counts), or nil.
    public mutating func update(micApp: String?, recording: String?, now: Date) -> Action? {
        switch phase {
        case .idle:
            if let micApp { phase = .starting(since: now, app: micApp) }
            return nil
        case .starting(let since, let app):
            guard micApp != nil else {
                phase = .idle
                return nil
            }
            guard now.timeIntervalSince(since) >= Self.startAfter else { return nil }
            phase = .inCall(began: since, before: recording, during: nil)
            guard recording == nil else { return nil }
            if let last = offered[app], now.timeIntervalSince(last) < Self.offerCooldown { return nil }
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
    /// also held by Siri, dictation tools and AI apps' voice modes, which aren't calls. Browsers are
    /// left out because the Hearth extension already offers notes for a Meet call.
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
        return callApps.contains(main)
    }

    /// Start, from a call, in the app's window: "Any app on this Mac", titled for that app.
    public static func startPath(app: String) -> String {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&=+#?/")
        return "/meetings/start?via=mac-call&app=" + (app.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")
    }
}
