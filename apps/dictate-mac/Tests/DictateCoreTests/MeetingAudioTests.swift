import Foundation
import Testing
@testable import DictateCore

@Suite struct MeetingFramerTests {
    @Test func handsOutWhole100msFramesAndHoldsTheRest() {
        let framer = MeetingFramer()
        #expect(framer.takeFrames() == nil)
        framer.append([Int16](repeating: 1, count: 1_000))
        #expect(framer.takeFrames() == nil)
        framer.append([Int16](repeating: 2, count: 2_500))
        let frames = framer.takeFrames()
        // 3,500 samples: two whole frames (3,200 samples = 6,400 bytes), 300 held back.
        #expect(frames?.count == 2 * MeetingAudio.bytesPerFrame)
        #expect(framer.takeFrames() == nil)
        framer.append([Int16](repeating: 3, count: 1_300))
        #expect(framer.takeFrames()?.count == MeetingAudio.bytesPerFrame)
    }

    @Test func framesArePCM16LittleEndianInOrder() {
        let framer = MeetingFramer()
        var samples = [Int16](repeating: 0, count: MeetingAudio.samplesPerFrame)
        samples[0] = 0x0102
        samples[1] = -2
        framer.append(samples)
        let frame = framer.takeFrames().map(Array.init) ?? []
        #expect(Array(frame.prefix(4)) == [0x02, 0x01, 0xFE, 0xFF])
    }

    @Test func resampledMicAudioBecomesExactFrames() {
        // 48 kHz for one second → 16,000 samples → ten frames once finished.
        let resampler = StreamingResampler(inputRate: 48_000)
        let framer = MeetingFramer()
        framer.append(resampler.process([Float](repeating: 0.1, count: 48_000)))
        framer.append(resampler.finish())
        #expect(framer.takeFrames()?.count == 10 * MeetingAudio.bytesPerFrame)
    }
}

@Suite struct MeetingAudioBridgeTests {
    @Test func parsesOnlyItsCommands() {
        #expect(MeetingAudio.Command.parse(["type": "start"]) == .start)
        #expect(MeetingAudio.Command.parse(["type": "stop", "session": "abc"]) == .stop(session: "abc"))
        #expect(MeetingAudio.Command.parse(["type": "pause", "session": "abc"]) == .pause(session: "abc"))
        #expect(MeetingAudio.Command.parse(["type": "resume", "session": "abc"]) == .resume(session: "abc"))
        #expect(MeetingAudio.Command.parse(["type": "pause"]) == nil)
        #expect(MeetingAudio.Command.parse(["type": "stop"]) == nil)
        #expect(MeetingAudio.Command.parse(["type": "stop", "session": ""]) == nil)
        #expect(MeetingAudio.Command.parse(["type": "start", "extra": 1]) == nil)
        #expect(MeetingAudio.Command.parse(["type": "record"]) == nil)
        #expect(MeetingAudio.Command.parse("start") == nil)
    }

    @Test func onlyMeetingsPagesMayRecord() {
        #expect(MeetingAudio.isMeetingsPath("/meetings/start"))
        #expect(MeetingAudio.isMeetingsPath("/meetings/live/abc"))
        #expect(MeetingAudio.isMeetingsPath("/meetings"))
        #expect(!MeetingAudio.isMeetingsPath("/meetingsx"))
        #expect(!MeetingAudio.isMeetingsPath("/docs/meetings/x"))
        #expect(!MeetingAudio.isMeetingsPath("/"))
    }

    @Test func encodesReplies() {
        let ok = MeetingAudio.started(session: "s1")
        #expect(ok["ok"] as? Bool == true)
        #expect(ok["session"] as? String == "s1")
        let no = MeetingAudio.failed(.noMic, message: "No microphone.")
        #expect(no["ok"] as? Bool == false)
        #expect(no["reason"] as? String == "no-mic")
        #expect(no["message"] as? String == "No microphone.")
    }

    @Test func encodesEventsAsTheWebPageReadsThem() {
        let event = MeetingAudio.framesEvent(session: "s1", me: Data([1, 2]), them: nil)
        #expect(event["session"] as? String == "s1")
        #expect(event["type"] as? String == "frames")
        #expect(event["me"] as? String == "AQI=")
        #expect(event["them"] == nil)
        let ended = MeetingAudio.endedEvent(session: "s1", track: .them)
        #expect(ended["type"] as? String == "ended")
        #expect(ended["track"] as? String == "them")
        #expect(MeetingAudio.dispatchScript.contains("'hearth-mac-audio'"))
    }
}
