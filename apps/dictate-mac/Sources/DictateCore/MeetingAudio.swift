import Foundation

/// "Any app on this Mac" for Hearth Meetings (docs/PLAN-record-any-call.md): the app records the
/// microphone and everything the Mac plays, and hands the Meetings page in its web view 100 ms
/// frames of 16 kHz mono PCM16 LE, which the page sends on the meeting socket unchanged.
public enum MeetingAudio {
    /// 100 ms at 16 kHz.
    public static let samplesPerFrame = 1_600
    public static let bytesPerFrame = samplesPerFrame * 2
    /// The event the page listens for.
    public static let eventName = "hearth-mac-audio"
    /// The script message handler the page posts to.
    public static let handlerName = "hearthMeetingAudio"

    public enum Track: String, Sendable { case me, them }

    /// What the page asks for.
    public enum Command: Equatable, Sendable {
        case start
        case stop(session: String)
        /// Pause releases the mic and the Mac's audio; resume takes them again.
        case pause(session: String)
        case resume(session: String)

        /// Strict: anything but these exact shapes is refused.
        public static func parse(_ body: Any) -> Command? {
            guard let dict = body as? [String: Any], let type = dict["type"] as? String else { return nil }
            switch type {
            case "start" where dict.count == 1:
                return .start
            case "stop", "pause", "resume":
                guard dict.count == 2, let session = dict["session"] as? String, !session.isEmpty else { return nil }
                return type == "stop" ? .stop(session: session) : type == "pause" ? .pause(session: session) : .resume(session: session)
            default:
                return nil
            }
        }
    }

    /// Why a start failed; the page shows `message` and maps `reason` to its own errors.
    public enum Failure: String, Sendable {
        case denied, noMic = "no-mic", unsupported
    }

    public static func started(session: String) -> [String: Any] {
        ["ok": true, "session": session]
    }

    public static func failed(_ reason: Failure, message: String) -> [String: Any] {
        ["ok": false, "reason": reason.rawValue, "message": message]
    }

    /// One delivery of whole frames; a track with nothing ready is left out.
    public static func framesEvent(session: String, me: Data?, them: Data?) -> [String: Any] {
        var event: [String: Any] = ["session": session, "type": "frames"]
        if let me, !me.isEmpty { event["me"] = me.base64EncodedString() }
        if let them, !them.isEmpty { event["them"] = them.base64EncodedString() }
        return event
    }

    public static func endedEvent(session: String, track: Track) -> [String: Any] {
        ["session": session, "type": "ended", "track": track.rawValue]
    }

    /// The call this recording was running through ended; the page counts down, then stops.
    public static func callEndedEvent(session: String) -> [String: Any] {
        ["session": session, "type": "call-ended"]
    }

    /// Only the Meetings pages may start or hear a recording of the whole Mac.
    public static func isMeetingsPath(_ path: String) -> Bool {
        path == "/meetings" || path.hasPrefix("/meetings/")
    }

    /// The page's script that fires the event; `detail` is passed as an argument, never spliced.
    public static let dispatchScript = "window.dispatchEvent(new CustomEvent('\(eventName)', { detail }))"
}

/// Collects converted 16 kHz samples for one track and hands out whole 100 ms frames. Thread
/// safe: the audio thread appends, the main thread takes.
public final class MeetingFramer: @unchecked Sendable {
    private var pending: [Int16] = []
    private let lock = NSLock()

    public init() {}

    public func append(_ samples: [Int16]) {
        guard !samples.isEmpty else { return }
        lock.lock()
        pending.append(contentsOf: samples)
        lock.unlock()
    }

    /// Every whole frame ready so far, as PCM16 LE; the remainder waits. Nil when none is ready.
    public func takeFrames() -> Data? {
        lock.lock()
        let whole = pending.count - pending.count % MeetingAudio.samplesPerFrame
        guard whole > 0 else {
            lock.unlock()
            return nil
        }
        let ready = Array(pending[0..<whole])
        pending.removeFirst(whole)
        lock.unlock()
        return Self.pcm16(ready)
    }

    static func pcm16(_ samples: [Int16]) -> Data {
        var data = Data(capacity: samples.count * 2)
        for sample in samples {
            let le = UInt16(bitPattern: sample.littleEndian)
            data.append(UInt8(le & 0xFF))
            data.append(UInt8(le >> 8))
        }
        return data
    }
}
