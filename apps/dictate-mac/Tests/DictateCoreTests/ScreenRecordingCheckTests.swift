import Foundation
import Testing
@testable import DictateCore

// docs/PLAN-screenshots.md R8: Screen Recording that macOS reports wrongly.

@Suite struct ScreenRecordingCheckTests {
    @Test func theAdviceFollowsWhatHappenedBefore() {
        #expect(ScreenRecordingCheck.advice(askedBefore: false, launchedSinceAsking: false) == .turnOn)
        #expect(ScreenRecordingCheck.advice(askedBefore: true, launchedSinceAsking: false) == .restart)
        #expect(ScreenRecordingCheck.advice(askedBefore: true, launchedSinceAsking: true) == .removeAndAddAgain)
    }

    @Test func onlyRealPermissionFailuresCount() {
        let domain = "com.apple.ScreenCaptureKit.SCStreamErrorDomain"
        // ScreenCaptureKit says declined, even when macOS's stale check says allowed.
        #expect(ScreenRecordingCheck.isPermissionFailure(domain: domain, code: -3801, preflightAllowed: true))
        // Another ScreenCaptureKit failure while allowed is just a failure.
        #expect(!ScreenRecordingCheck.isPermissionFailure(domain: domain, code: -3802, preflightAllowed: true))
        #expect(!ScreenRecordingCheck.isPermissionFailure(domain: NSCocoaErrorDomain, code: 4, preflightAllowed: true))
        // Any failure while macOS reports no permission is about permission.
        #expect(ScreenRecordingCheck.isPermissionFailure(domain: NSCocoaErrorDomain, code: 4, preflightAllowed: false))
    }

    func defaults() -> (UserDefaults, String) {
        let name = "screen-recording-\(UUID().uuidString)"
        return (UserDefaults(suiteName: name)!, name)
    }

    @Test func remembersAcrossLaunches() {
        let (d, name) = defaults()
        defer { d.removePersistentDomain(forName: name) }
        let first = ScreenRecordingCheck.Memory(defaults: d, launch: "run-1")
        #expect(first.adviceAfterFailure() == .turnOn)
        #expect(first.adviceAfterFailure() == .restart) // asked again in the same run
        let second = ScreenRecordingCheck.Memory(defaults: d, launch: "run-2")
        #expect(second.adviceAfterFailure() == .removeAndAddAgain)
        #expect(second.adviceAfterFailure() == .restart)
        second.forget() // a capture worked
        #expect(ScreenRecordingCheck.Memory(defaults: d, launch: "run-3").adviceAfterFailure() == .turnOn)
    }
}
