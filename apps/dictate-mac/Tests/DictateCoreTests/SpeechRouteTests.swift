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

    // docs/PLAN-dictate-models.md, R8.
    @Test func keepsSpeechOnTheMacWhenTheMemberChoseIt() {
        #expect(SpeechRouting.choose(networkUp: true, serverFailedAt: nil, now: now, keepOnMac: true) == .onDevice)
        #expect(SpeechRouting.choose(networkUp: false, serverFailedAt: nil, now: now, keepOnMac: true) == .onDevice)
        #expect(SpeechRouting.choose(networkUp: true, serverFailedAt: nil, now: now, keepOnMac: false) == .server)
    }

    @Test func aRefusalMayMeanTheMemberJustChoseOnThisMacOnly() {
        #expect(SpeechRouting.mayBeKeptOnMac(after: .server(status: 403, message: "On this Mac only")))
        #expect(!SpeechRouting.mayBeKeptOnMac(after: .server(status: 500, message: "busy")))
        #expect(!SpeechRouting.mayBeKeptOnMac(after: .network("offline")))
        #expect(!SpeechRouting.mayBeKeptOnMac(after: .notConnected))
    }

    @Test func remembersTheChoicesOnThisMacUntilANewConnection() throws {
        let defaults = try #require(UserDefaults(suiteName: "SpeechPreferenceTests"))
        defaults.removePersistentDomain(forName: "SpeechPreferenceTests")
        #expect(SpeechPreference.known(defaults) == nil)
        SpeechPreference.set(.init(keepOnMac: true, tidy: false), in: defaults)
        #expect(SpeechPreference.known(defaults) == .init(keepOnMac: true, tidy: false))
        SpeechPreference.set(.init(keepOnMac: false, tidy: true), in: defaults)
        #expect(SpeechPreference.known(defaults) == .init(keepOnMac: false, tidy: true))
        SpeechPreference.forget(defaults)
        #expect(SpeechPreference.known(defaults) == nil)
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

    @Test func anUploadAfterAStreamThatNeverGotReadyGivesUpQuickly() {
        #expect(SpeechRouting.uploadTimeout(streamReady: false) <= 10)
        #expect(SpeechRouting.uploadTimeout(streamReady: true) == 90)
        // No stream at all (a Retry): the usual timeout.
        #expect(SpeechRouting.uploadTimeout(streamReady: nil) == 90)
    }

    @Test func onDeviceRecognitionHasTimeForLongDictations() {
        #expect(SpeechRouting.onDeviceTimeout(seconds: 5) == 30)
        #expect(SpeechRouting.onDeviceTimeout(seconds: 450) >= 450)
    }

    @Test func speaksTheMacsLanguageWhenItHasAnOnDeviceModel() {
        let onDevice = ["en-US", "en-GB", "fr-FR", "fr-CA", "de-DE"]
        #expect(SpeechRouting.locale(preferred: ["fr-FR", "en-US"], onDevice: onDevice, region: nil) == "fr-FR")
        #expect(SpeechRouting.locale(preferred: ["en_GB"], onDevice: onDevice, region: nil) == "en-GB")
        // A language without the region the Mac names: the Mac's region if there is one…
        #expect(SpeechRouting.locale(preferred: ["fr"], onDevice: onDevice, region: "CA") == "fr-CA")
        // …else always the same one, whatever order the system lists them in.
        #expect(SpeechRouting.locale(preferred: ["fr"], onDevice: onDevice, region: "JP") == "fr-CA")
        #expect(SpeechRouting.locale(preferred: ["fr"], onDevice: onDevice.reversed(), region: "JP") == "fr-CA")
        #expect(SpeechRouting.locale(preferred: ["de-CH"], onDevice: onDevice, region: "CH") == "de-DE")
    }

    @Test func chineseScriptsPickTheirOwnRegion() {
        let onDevice = ["zh-CN", "zh-HK", "zh-TW", "en-US"]
        #expect(SpeechRouting.locale(preferred: ["zh-Hans-CN"], onDevice: onDevice, region: "CN") == "zh-CN")
        #expect(SpeechRouting.locale(preferred: ["zh-Hans"], onDevice: onDevice, region: "US") == "zh-CN")
        #expect(SpeechRouting.locale(preferred: ["zh-Hant-TW"], onDevice: onDevice, region: "TW") == "zh-TW")
    }

    @Test func fallsBackToUSEnglishThenToNothing() {
        // The Mac's language has no on-device model here: English, which does.
        #expect(SpeechRouting.locale(preferred: ["da-DK"], onDevice: ["en-US", "fr-FR"], region: "DK") == "en-US")
        #expect(SpeechRouting.locale(preferred: ["ja-JP"], onDevice: ["fr-FR"], region: nil) == nil)
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
