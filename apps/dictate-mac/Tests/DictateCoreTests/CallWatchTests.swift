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

    @Test func aDroppedTickWhileTheCallStartsStillOffers() {
        // Zoom lets go of the mic for one 2 s tick inside the first 4 s (joining muted, a device
        // switch, two Core Audio reads disagreeing): still one call, offered once.
        var watch = CallWatch()
        var actions = run(&watch, from: 0, for: 2, app: "Zoom", recording: nil)
        actions += run(&watch, from: 2, for: 2, app: nil, recording: nil)
        // Offered on time, counted from when Zoom first took the mic (not restarted by the drop).
        actions += run(&watch, from: 4, for: 2, app: "Zoom", recording: nil)
        #expect(actions == [.offerNotes(app: "Zoom")])
        #expect(run(&watch, from: 6, for: 60, app: "Zoom", recording: nil).isEmpty)
    }

    @Test func aMicThatFlickersEveryOtherTickIsStillACall() {
        var watch = CallWatch()
        var actions: [CallWatch.Action] = []
        for tick in 0..<15 {
            let at = TimeInterval(tick * 2)
            if let action = watch.update(micApp: tick.isMultiple(of: 2) ? "Zoom" : nil, recording: nil, now: t0.addingTimeInterval(at)) {
                actions.append(action)
            }
        }
        #expect(actions == [.offerNotes(app: "Zoom")])
    }

    @Test func twoDroppedTicksWhileTheCallStartsStillOffer() {
        var watch = CallWatch()
        var actions = run(&watch, from: 0, for: 2, app: "Zoom", recording: nil)
        actions += run(&watch, from: 2, for: 4, app: nil, recording: nil)
        actions += run(&watch, from: 6, for: 30, app: "Zoom", recording: nil)
        #expect(actions == [.offerNotes(app: "Zoom")])
    }

    @Test func twoDroppedTicksOnALateTimerStillOffer() {
        // A real 2 s timer runs a little late: two missed ticks measure just over 4 s.
        var watch = CallWatch()
        var actions: [CallWatch.Action] = []
        let present = [true, false, false, true, true, true]
        for (tick, here) in present.enumerated() {
            if let action = watch.update(micApp: here ? "Zoom" : nil, recording: nil, now: t0.addingTimeInterval(Double(tick) * 2.05)) {
                actions.append(action)
            }
        }
        #expect(actions == [.offerNotes(app: "Zoom")])
    }

    @Test func aGrabThatStopsForGoodWithinFourSecondsIsNotACall() {
        var watch = CallWatch()
        #expect(run(&watch, from: 0, for: 2, app: "Zoom", recording: nil).isEmpty)
        #expect(run(&watch, from: 2, for: 60, app: nil, recording: nil).isEmpty)
        // Gone longer than the gap allowed: the next grab starts its own 4 s count.
        #expect(run(&watch, from: 62, for: 4, app: "Zoom", recording: nil).isEmpty)
    }

    @Test func noOfferWhileAlreadyRecording() {
        var watch = CallWatch()
        #expect(run(&watch, from: 0, for: 30, app: "Zoom", recording: "a") == [.skipped(app: "Zoom", reason: .recording)])
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
        #expect(run(&watch, from: 140, for: 20, app: "Zoom", recording: nil) == [.skipped(app: "Zoom", reason: .cooldown)])
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
        // Browsers count (a Google Meet in Chrome), but not Safari: its mic runs in WebKit's
        // shared process, which this app's own window uses too.
        #expect(MicApps.isCallCandidate("com.google.Chrome.helper", ownBundleID: own))
        #expect(MicApps.isCallCandidate("com.google.Chrome", ownBundleID: own))
        #expect(MicApps.isCallCandidate("company.thebrowser.Browser.helper", ownBundleID: own))
        #expect(MicApps.isCallCandidate("com.microsoft.edgemac.helper", ownBundleID: own))
        #expect(MicApps.isCallCandidate("org.mozilla.firefox", ownBundleID: own))
        #expect(!MicApps.isCallCandidate("com.apple.Safari", ownBundleID: own))
        #expect(!MicApps.isCallCandidate("com.apple.WebKit.GPU", ownBundleID: own))
        #expect(!MicApps.isCallCandidate(own, ownBundleID: own))
        #expect(!MicApps.isCallCandidate(nil, ownBundleID: own))
    }

    @Test func browsersAreKnown() {
        #expect(MicApps.isBrowser("com.google.Chrome.helper"))
        #expect(MicApps.isBrowser("com.brave.Browser"))
        #expect(MicApps.isBrowser("com.google.Chrome.app.kjgfgldnnfoeklkmfkjfagphfepbbdan"))
        #expect(!MicApps.isBrowser("us.zoom.xos"))
        #expect(!MicApps.isBrowser(nil))
    }

    @Test func aBrowserCallIsNamedForTheServiceInItsWindow() {
        #expect(MicApps.callName(windowTitles: ["Inbox", "Meet - yma-qafi-tzc 🔊"], browser: "Google Chrome") == "Google Meet")
        #expect(MicApps.callName(windowTitles: ["Google Meet"], browser: "Arc") == "Google Meet")
        #expect(MicApps.callName(windowTitles: ["Chat | Microsoft Teams"], browser: "Microsoft Edge") == "Microsoft Teams")
        #expect(MicApps.callName(windowTitles: ["Zoom Meeting"], browser: "Google Chrome") == "Zoom")
        // Nothing recognised (another site using the mic, or no Accessibility): the browser's name.
        #expect(MicApps.callName(windowTitles: ["Voice memo"], browser: "Google Chrome") == "Google Chrome")
        #expect(MicApps.callName(windowTitles: [], browser: "Firefox") == "Firefox")
        // A doc that only mentions a meeting isn't one.
        #expect(MicApps.callName(windowTitles: ["Meeting notes - Google Docs"], browser: "Google Chrome") == "Google Chrome")
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
