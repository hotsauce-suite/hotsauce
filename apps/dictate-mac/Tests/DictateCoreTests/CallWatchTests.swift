import Foundation
import Testing
@testable import DictateCore

@Suite struct CallWatchTests {
    let t0 = Date(timeIntervalSince1970: 1_000_000)

    /// Runs one update per 2 s tick from `start` for `seconds`, returning every action.
    func run(_ watch: inout CallWatch, from start: TimeInterval, for seconds: TimeInterval, app: String?, recording: String?) -> [CallWatch.Action] {
        var actions: [CallWatch.Action] = []
        var at = start
        while at < start + seconds {
            if let action = watch.update(micApp: app, recording: recording, now: t0.addingTimeInterval(at)) { actions.append(action) }
            at += 2
        }
        return actions
    }

    @Test func offersNotesOnceACallHasHeldTheMic() {
        var watch = CallWatch()
        #expect(run(&watch, from: 0, for: 120, app: "Zoom", recording: nil) == [.offerNotes(app: "Zoom")])
    }

    @Test func aBriefGrabIsNotACall() {
        var watch = CallWatch()
        #expect(run(&watch, from: 0, for: 4, app: "Zoom", recording: nil).isEmpty)
        #expect(run(&watch, from: 4, for: 30, app: nil, recording: nil).isEmpty)
    }

    @Test func noOfferWhileAlreadyRecording() {
        var watch = CallWatch()
        #expect(run(&watch, from: 0, for: 30, app: "Zoom", recording: "a").isEmpty)
    }

    @Test func aShortDropDuringACallIsNotTheEndAndDoesNotOfferAgain() {
        var watch = CallWatch()
        _ = run(&watch, from: 0, for: 30, app: "Zoom", recording: nil)
        #expect(run(&watch, from: 30, for: 16, app: nil, recording: nil).isEmpty)
        #expect(run(&watch, from: 46, for: 60, app: "Zoom", recording: nil).isEmpty)
    }

    @Test func theEndOfACallRecordedFromItsOfferIsReportedOnceForThatRecording() {
        var watch = CallWatch()
        #expect(run(&watch, from: 0, for: 10, app: "Zoom", recording: nil) == [.offerNotes(app: "Zoom")])
        // The member took notes.
        #expect(run(&watch, from: 10, for: 120, app: "Zoom", recording: "m1").isEmpty)
        #expect(run(&watch, from: 130, for: 40, app: nil, recording: "m1") == [.callEnded(session: "m1")])
    }

    @Test func aRecordingRunningBeforeTheCallIsNeverStoppedForIt() {
        // An in-person meeting recording the Mac takes a FaceTime call in the middle.
        var watch = CallWatch()
        _ = run(&watch, from: 0, for: 120, app: "FaceTime", recording: "inperson")
        #expect(run(&watch, from: 120, for: 40, app: nil, recording: "inperson") == [.callOver])
    }

    @Test func noEndWhenTheRecordingStoppedOrTheCallWasShort() {
        var stopped = CallWatch()
        _ = run(&stopped, from: 0, for: 10, app: "Zoom", recording: nil)
        _ = run(&stopped, from: 10, for: 110, app: "Zoom", recording: "m1")
        #expect(run(&stopped, from: 120, for: 40, app: nil, recording: nil) == [.callOver])

        var short = CallWatch()
        _ = run(&short, from: 0, for: 10, app: "Slack", recording: nil)
        _ = run(&short, from: 10, for: 20, app: "Slack", recording: "m1")
        #expect(run(&short, from: 30, for: 40, app: nil, recording: "m1") == [.callOver])
    }

    @Test func aLaterRecordingDuringTheCallIsTheOneReported() {
        var watch = CallWatch()
        _ = run(&watch, from: 0, for: 10, app: "Zoom", recording: nil)
        _ = run(&watch, from: 10, for: 30, app: "Zoom", recording: "a")
        _ = run(&watch, from: 40, for: 10, app: "Zoom", recording: nil)
        _ = run(&watch, from: 50, for: 60, app: "Zoom", recording: "b")
        #expect(run(&watch, from: 110, for: 40, app: nil, recording: "b") == [.callEnded(session: "b")])
    }

    @Test func aNewCallIsOfferedAgainButNotTheSameAppRightAway() {
        var watch = CallWatch()
        _ = run(&watch, from: 0, for: 60, app: "Zoom", recording: nil)
        #expect(run(&watch, from: 60, for: 30, app: nil, recording: nil) == [.callOver])
        #expect(run(&watch, from: 90, for: 20, app: "FaceTime", recording: nil) == [.offerNotes(app: "FaceTime")])
        _ = run(&watch, from: 110, for: 30, app: nil, recording: nil)
        // Zoom again within ten minutes (a long mute): no second offer.
        #expect(run(&watch, from: 140, for: 20, app: "Zoom", recording: nil).isEmpty)
        _ = run(&watch, from: 160, for: 30, app: nil, recording: nil)
        #expect(run(&watch, from: 700, for: 20, app: "Zoom", recording: nil) == [.offerNotes(app: "Zoom")])
    }
}

@Suite struct MicAppsTests {
    @Test func callAppsCountOtherMicUsersDoNot() {
        let own = "dev.hotsauce.dictate"
        #expect(MicApps.isCallCandidate("us.zoom.xos", ownBundleID: own))
        #expect(MicApps.isCallCandidate("com.tinyspeck.slackmacgap.helper", ownBundleID: own))
        #expect(MicApps.isCallCandidate("com.apple.FaceTime", ownBundleID: own))
        #expect(MicApps.isCallCandidate("com.microsoft.teams2.Helper.Renderer", ownBundleID: own))
        #expect(MicApps.isCallCandidate("com.apple.avconferenced", ownBundleID: own))
        // Seen holding the mic on a test Mac with no call: Siri, the Claude app's voice mode, QuickTime.
        #expect(!MicApps.isCallCandidate("com.apple.CoreSpeech", ownBundleID: own))
        #expect(!MicApps.isCallCandidate("com.anthropic.claudefordesktop.helper", ownBundleID: own))
        #expect(!MicApps.isCallCandidate("com.apple.QuickTimePlayerX", ownBundleID: own))
        #expect(!MicApps.isCallCandidate("com.google.Chrome.helper", ownBundleID: own))
        #expect(!MicApps.isCallCandidate("com.apple.WebKit.GPU", ownBundleID: own))
        #expect(!MicApps.isCallCandidate(own, ownBundleID: own))
        #expect(!MicApps.isCallCandidate(nil, ownBundleID: own))
    }

    @Test func helpersBelongToTheirApp() {
        #expect(MicApps.mainBundleID("com.tinyspeck.slackmacgap.helper") == "com.tinyspeck.slackmacgap")
        #expect(MicApps.mainBundleID("com.microsoft.teams2.Helper.Renderer") == "com.microsoft.teams2")
        #expect(MicApps.mainBundleID("us.zoom.xos") == "us.zoom.xos")
    }

    @Test func startPathNamesTheAppSafely() {
        #expect(MicApps.startPath(app: "Zoom") == "/meetings/start?via=mac-call&app=Zoom")
        #expect(MicApps.startPath(app: "A&B=C") == "/meetings/start?via=mac-call&app=A%26B%3DC")
    }
}
