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
    /// "ready" is almost certainly talking to nobody: give up fast so the device takes over.
    public static func finishTimeout(streamReady: Bool) -> TimeInterval {
        streamReady ? 25 : 3
    }

    /// The on-device language (A2.7): the first of the Mac's languages with a model, matched
    /// exactly or by language alone, else US English, else none.
    public static func locale(preferred: [String], supported: [String]) -> String? {
        let normal = { (id: String) in id.replacingOccurrences(of: "_", with: "-") }
        let available = supported.map(normal)
        let language = { (id: String) in id.split(separator: "-").first.map(String.init)?.lowercased() ?? "" }
        for wanted in preferred.map(normal) {
            if let exact = available.first(where: { $0.caseInsensitiveCompare(wanted) == .orderedSame }) {
                return exact
            }
            if let sameLanguage = available.first(where: { language($0) == language(wanted) }) {
                return sameLanguage
            }
        }
        return available.first { $0 == "en-US" }
    }
}
