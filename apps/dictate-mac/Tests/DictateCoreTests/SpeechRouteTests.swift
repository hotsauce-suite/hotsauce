import Foundation
import Testing
@testable import DictateCore

// docs/PLAN-offline.md, step A2: when Dictate writes up on the Mac instead of the server.
@Suite struct SpeechRouteTests {
    private let now = Date(timeIntervalSince1970: 1_000_000)

    @Test func usesTheServerWhenTheMacIsOnlineAndTheServerAnswered() {
        #expect(SpeechRouting.choose(networkUp: true, serverFailedAt: nil, now: now) == .server)
    }

    @Test func usesTheDeviceWithNoNetwork() {
        #expect(SpeechRouting.choose(networkUp: false, serverFailedAt: nil, now: now) == .onDevice)
    }

    @Test func usesTheDeviceForAMinuteAfterTheServerDidNotAnswer() {
        let justNow = now.addingTimeInterval(-10)
        let longAgo = now.addingTimeInterval(-61)
        #expect(SpeechRouting.choose(networkUp: true, serverFailedAt: justNow, now: now) == .onDevice)
        #expect(SpeechRouting.choose(networkUp: true, serverFailedAt: longAgo, now: now) == .server)
    }

    @Test func onlyAServerThatCouldNotBeReachedMovesToTheDevice() {
        #expect(SpeechRouting.fallsBackOnDevice(after: .network("offline")))
        #expect(!SpeechRouting.fallsBackOnDevice(after: .notConnected))
        #expect(!SpeechRouting.fallsBackOnDevice(after: .server(status: 500, message: "busy")))
        #expect(!SpeechRouting.fallsBackOnDevice(after: .server(status: 413, message: "too long")))
    }

    @Test func aStreamThatNeverGotReadyGivesUpQuickly() {
        #expect(SpeechRouting.finishTimeout(streamReady: false) <= 3)
        #expect(SpeechRouting.finishTimeout(streamReady: true) == 25)
    }

    @Test func speaksTheMacsLanguageWhenItHasAnOnDeviceModel() {
        let supported = ["en-US", "en-GB", "fr-FR", "de-DE"]
        #expect(SpeechRouting.locale(preferred: ["fr-FR", "en-US"], supported: supported) == "fr-FR")
        #expect(SpeechRouting.locale(preferred: ["en_GB"], supported: supported) == "en-GB")
        // A language without the region the Mac names: the first one for that language.
        #expect(SpeechRouting.locale(preferred: ["de-CH"], supported: supported) == "de-DE")
        #expect(SpeechRouting.locale(preferred: ["fr"], supported: supported) == "fr-FR")
    }

    @Test func fallsBackToUSEnglishThenToNothing() {
        #expect(SpeechRouting.locale(preferred: ["ja-JP"], supported: ["en-US", "fr-FR"]) == "en-US")
        #expect(SpeechRouting.locale(preferred: ["ja-JP"], supported: ["fr-FR"]) == nil)
    }

    @Test func anOnDeviceDictationIsKeptInHistoryMarkedAsSuch() throws {
        let record = DictationRecord(date: now, text: "Written on the plane", cleaned: false,
                                     appName: nil, appBundle: nil, audioMs: 1200, onDevice: true)
        let decoded = try JSONDecoder().decode(DictationRecord.self, from: JSONEncoder().encode(record))
        #expect(decoded.onDevice == true)
        // Records saved before this have no mark: they came from the server.
        var old = try JSONSerialization.jsonObject(with: JSONEncoder().encode(record)) as! [String: Any]
        old.removeValue(forKey: "onDevice")
        let legacy = try JSONDecoder().decode(DictationRecord.self, from: JSONSerialization.data(withJSONObject: old))
        #expect(legacy.onDevice != true)
    }
}
