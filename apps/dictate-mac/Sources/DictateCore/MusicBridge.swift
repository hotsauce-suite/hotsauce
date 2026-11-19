import Foundation

/// The background music in the app (docs/PLAN-background-music.md, M9 to M11). The suite's page
/// keeps the one player (apps/web/src/music/macBridge.ts); the app plays and pauses it from its
/// menus and holds it while the app itself dictates or records a call. The page tells the app what
/// the player is doing through the `hotsauceMusic` handler; the app answers through
/// `window.hotsauceMusic`.
public enum MusicBridge {
    public static let handlerName = "hotsauceMusic"

    public struct Track: Equatable, Sendable {
        public let id: String
        public let label: String
        public init(id: String, label: String) {
            self.id = id
            self.label = label
        }
    }

    public struct State: Equatable, Sendable {
        public var on: Bool
        public var playing: Bool
        public var held: Bool
        /// On, but silent until the member clicks or asks (after login): the menus offer Play.
        public var waiting: Bool
        public var track: String
        public var tracks: [Track]

        public init(on: Bool, playing: Bool, held: Bool, waiting: Bool = false, track: String, tracks: [Track]) {
            self.on = on
            self.playing = playing
            self.held = held
            self.waiting = waiting
            self.track = track
            self.tracks = tracks
        }

        /// The menu bar menu's line: "Play music" or "Pause music".
        public var toggleTitle: String { on && !isWaiting ? "Pause music" : "Play music" }

        /// Left on from last time but not started yet: nothing is heard.
        var isWaiting: Bool { on && waiting && !playing && !held }

        /// A few words on what it's doing, under the toggle; nil while off.
        public var status: String? {
            guard on, !isWaiting else { return nil }
            if held { return "Paused while recording" }
            let label = tracks.first { $0.id == track }?.label ?? "Music"
            return playing ? "Playing: \(label)" : "\(label): starting…"
        }
    }

    /// Reads what the page posted; nil for anything that isn't the page's state (strict, since
    /// any script on the page can post to the handler).
    public static func state(_ body: Any) -> State? {
        guard let dict = body as? [String: Any],
              let on = dict["on"] as? Bool,
              let playing = dict["playing"] as? Bool,
              let held = dict["held"] as? Bool,
              let track = dict["track"] as? String, isTrackID(track),
              let list = dict["tracks"] as? [Any], list.count <= 12
        else { return nil }
        var tracks: [Track] = []
        for entry in list {
            guard let t = entry as? [String: Any],
                  let id = t["id"] as? String, isTrackID(id),
                  let label = t["label"] as? String, !label.isEmpty, label.count <= 40
            else { return nil }
            tracks.append(Track(id: id, label: label))
        }
        // Older pages don't say; they never wait in the app.
        let waiting = dict["waiting"] as? Bool ?? false
        return State(on: on, playing: playing, held: held, waiting: waiting, track: track, tracks: tracks)
    }

    /// What the app may ask the page to do.
    public enum Command: Equatable, Sendable {
        case toggle
        case play
        case stop
        case track(String)

        /// The string `window.hotsauceMusic.command` takes.
        public var argument: String? {
            switch self {
            case .toggle: return "toggle"
            case .play: return "play"
            case .stop: return "stop"
            case .track(let id): return isTrackID(id) ? "track:\(id)" : nil
            }
        }
    }

    /// Why the app holds the music: the page knows only these two.
    public enum HoldReason: String, Sendable {
        case dictate
        case meeting
    }

    /// Runs with `callAsyncJavaScript`, `command` passed as an argument (never pasted into the
    /// script). A page without the player (an old release, the sign-in page) ignores it.
    public static let commandScript = "window.hotsauceMusic?.command(command)"

    /// Runs with `callAsyncJavaScript`, `reason` and `on` passed as arguments.
    public static let holdScript = "window.hotsauceMusic?.hold(reason, on)"

    static func isTrackID(_ id: String) -> Bool {
        !id.isEmpty && id.count <= 32 && id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
    }
}
