import Foundation

/// Where a dictation is written up (docs/PLAN-offline.md, step A2): by the Hotsauce server, or by
/// the Mac's own speech recognition when the server can't be reached.
public enum SpeechRoute: Equatable, Sendable {
    case server
    case onDevice
}

public enum SpeechRouting {
    /// A server that didn't answer is left alone this long before it's tried again (A2.1).
    public static let serverDownFor: TimeInterval = 60

    /// At the key press: the device when the Mac has no network or the server just failed.
    public static func choose(networkUp: Bool, serverFailedAt: Date?, now: Date) -> SpeechRoute {
        guard networkUp else { return .onDevice }
        if let failed = serverFailedAt, now.timeIntervalSince(failed) < serverDownFor { return .onDevice }
        return .server
    }

    /// After a dictation sent to the server failed (A2.2): only one that couldn't reach it is
    /// written up on the device. A refusal (signed out, too long, the server's own error) isn't
    /// about the connection, and the device wouldn't give the member what they asked for.
    public static func fallsBackOnDevice(after error: DictationError) -> Bool {
        if case .network = error { return true }
        return false
    }

    /// How long after key-up the stream waits for the server's text (A2.3). One that never heard
    /// "ready" is almost certainly talking to nobody: give up fast so the device takes over. (When
    /// "ready" arrives late, the stream moves its deadline to the full 25 seconds.)
    public static func finishTimeout(streamReady: Bool) -> TimeInterval {
        streamReady ? 25 : 3
    }

    /// The upload's timeout after the stream gave up (A2.3): short when the stream never heard
    /// "ready", since the server isn't answering. It's an idle timeout, so a slow upload that is
    /// moving still finishes. Nil: no stream (a Retry).
    public static func uploadTimeout(streamReady: Bool?) -> TimeInterval {
        streamReady == false ? 10 : 90
    }

    /// How long on-device recognition may take: half a minute, or longer for a long dictation.
    public static func onDeviceTimeout(seconds: TimeInterval) -> TimeInterval {
        max(30, seconds * 1.5)
    }

    /// The on-device language (A2.7): the first of the Mac's languages that has an on-device
    /// model (`onDevice`), matched exactly, else by language (the Mac's region first, then the
    /// first in order, so it's the same every time); else US English; else none.
    public static func locale(preferred: [String], onDevice: [String], region: String?) -> String? {
        let available = onDevice.map(normal).sorted()
        for wanted in preferred.map(normal).map(scriptToRegion) {
            if let exact = available.first(where: { $0.caseInsensitiveCompare(wanted) == .orderedSame }) {
                return exact
            }
            let sameLanguage = available.filter { language($0) == language(wanted) }
            let wantedRegion = regionOf(wanted) ?? region?.uppercased()
            if let regional = sameLanguage.first(where: { regionOf($0) == wantedRegion }) { return regional }
            if let any = sameLanguage.first { return any }
        }
        return available.first { $0 == "en-US" }
    }

    private static func normal(_ id: String) -> String { id.replacingOccurrences(of: "_", with: "-") }

    private static func language(_ id: String) -> String {
        id.split(separator: "-").first.map(String.init)?.lowercased() ?? ""
    }

    private static func regionOf(_ id: String) -> String? {
        id.split(separator: "-").dropFirst().map(String.init).first { $0.count == 2 }?.uppercased()
    }

    /// Chinese names its script, not its region: Simplified is mainland, Traditional is Taiwan,
    /// unless a region is named too.
    private static func scriptToRegion(_ id: String) -> String {
        let parts = id.split(separator: "-").map(String.init)
        guard parts.first?.lowercased() == "zh", parts.count >= 2 else { return id }
        if parts.count >= 3 { return "zh-\(parts[2])" }
        switch parts[1].lowercased() {
        case "hans": return "zh-CN"
        case "hant": return "zh-TW"
        default: return id
        }
    }
}
