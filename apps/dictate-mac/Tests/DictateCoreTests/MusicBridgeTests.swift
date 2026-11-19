import DictateCore
import Foundation
import Testing

/// docs/PLAN-background-music.md M9 and M10: the app's side of the music bridge.
struct MusicBridgeTests {
    private let tracks: [[String: Any]] = [
        ["id": "piano", "label": "Soft piano"],
        ["id": "lofi", "label": "Lo-fi"],
    ]

    @Test func readsThePagesState() {
        let state = MusicBridge.state(["on": true, "playing": true, "held": false, "track": "lofi", "tracks": tracks])
        #expect(state == MusicBridge.State(
            on: true, playing: true, held: false, track: "lofi",
            tracks: [.init(id: "piano", label: "Soft piano"), .init(id: "lofi", label: "Lo-fi")]
        ))
        #expect(state?.toggleTitle == "Pause music")
        #expect(state?.status == "Playing: Lo-fi")
    }

    @Test func saysWhenOffOrHeld() {
        let off = MusicBridge.state(["on": false, "playing": false, "held": false, "track": "piano", "tracks": tracks])
        #expect(off?.toggleTitle == "Play music")
        #expect(off?.status == nil)
        let held = MusicBridge.state(["on": true, "playing": false, "held": true, "track": "piano", "tracks": tracks])
        #expect(held?.status == "Paused while recording")
    }

    @Test func refusesAnythingElse() {
        #expect(MusicBridge.state("play") == nil)
        #expect(MusicBridge.state(["on": "yes", "playing": false, "held": false, "track": "piano", "tracks": tracks]) == nil)
        #expect(MusicBridge.state(["on": true, "playing": false, "held": false, "track": "../x", "tracks": tracks]) == nil)
        #expect(MusicBridge.state(["on": true, "playing": false, "held": false, "track": "piano", "tracks": [["id": "a b", "label": "x"]]]) == nil)
        let many = Array(repeating: ["id": "a", "label": "A"], count: 13)
        #expect(MusicBridge.state(["on": true, "playing": false, "held": false, "track": "a", "tracks": many]) == nil)
    }

    @Test func commandsAreOnlyKnownStrings() {
        #expect(MusicBridge.Command.toggle.argument == "toggle")
        #expect(MusicBridge.Command.play.argument == "play")
        #expect(MusicBridge.Command.stop.argument == "stop")
        #expect(MusicBridge.Command.track("rain").argument == "track:rain")
        #expect(MusicBridge.Command.track("rain'); alert(1); ('").argument == nil)
        #expect(MusicBridge.HoldReason.dictate.rawValue == "dictate")
        #expect(MusicBridge.HoldReason.meeting.rawValue == "meeting")
    }
}
