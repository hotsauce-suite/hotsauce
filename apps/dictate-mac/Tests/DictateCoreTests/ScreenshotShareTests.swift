import Foundation
import Testing
@testable import DictateCore

// docs/PLAN-screenshots.md R14 (Share) and R15 (Settings → This Mac → Screenshots).

@Suite struct ScreenshotShareTests {
    let london = TimeZone(identifier: "Europe/London")!
    let uk = Locale(identifier: "en_GB")
    let us = Locale(identifier: "en_US")

    @Test func aSharedLinkForAnyone() {
        let outcome = ScreenshotShare.parse([
            "ok": true, "url": "https://hotsauce.example.com/s/abc", "anyone": true, "deleteAfter": "2026-12-19T22:58:41.123Z",
        ] as [String: Any])
        guard case let .shared(url, anyone, deleteAfter) = outcome else { Issue.record("not shared"); return }
        #expect(url.absoluteString == "https://hotsauce.example.com/s/abc")
        #expect(anyone)
        #expect(deleteAfter != nil)
        #expect(ScreenshotShare.message(outcome, locale: uk, timeZone: london) == "Link copied. Anyone with the link can open it until 19 December 2026.")
        #expect(ScreenshotShare.message(outcome, locale: us, timeZone: london) == "Link copied. Anyone with the link can open it until December 19, 2026.")
    }

    @Test func aLinkForMembersOnly() {
        let outcome = ScreenshotShare.parse(["ok": true, "url": "https://h.example/s/x", "anyone": false, "deleteAfter": NSNull()] as [String: Any])
        #expect(outcome == .shared(url: URL(string: "https://h.example/s/x")!, anyone: false, deleteAfter: nil))
        #expect(ScreenshotShare.message(outcome) == "Link copied. Only signed-in members can open it (public links are off for this organization).")
    }

    @Test func noPageNoFunctionOrNotSignedInAllSaySignIn() {
        for answer: Any? in [nil, "nonsense", ["missing": true], ["ok": false, "error": "Sign in to Hotsauce to share a screenshot."]] {
            let outcome = ScreenshotShare.parse(answer)
            #expect(outcome == .failed(.notSignedIn))
            #expect(ScreenshotShare.message(outcome) == "Open Hotsauce and sign in, then press Share again.")
        }
    }

    @Test func tooLargeAndThePagesOwnWords() {
        #expect(ScreenshotShare.parse(["ok": false, "error": "That screenshot is too large to share."]) == .failed(.tooLarge))
        #expect(ScreenshotShare.message(.failed(.tooLarge)).contains("too large to share"))
        let other = ScreenshotShare.parse(["ok": false, "error": "Files is full."])
        #expect(other == .failed(.page("Files is full.")))
        #expect(ScreenshotShare.message(other) == "Files is full.")
        #expect(ScreenshotShare.parse(["ok": false]) == .failed(.page("Couldn’t share the screenshot.")))
    }

    @Test func aMalformedSuccessIsNeverALink() {
        for answer: [String: Any] in [
            ["ok": true],
            ["ok": true, "url": "javascript:alert(1)"],
            ["ok": true, "url": "/s/relative"],
            ["ok": 1, "url": "https://h.example/s/x"],
        ] {
            guard case .failed = ScreenshotShare.parse(answer) else { Issue.record("took \(answer) as a link"); continue }
        }
    }

    @Test func aLinkToAnotherHostIsNotTaken() {
        let answer: [String: Any] = ["ok": true, "url": "https://evil.example/s/x", "anyone": true]
        guard case .failed = ScreenshotShare.parse(answer, expectedHost: "hotsauce.example.com") else { Issue.record("took it"); return }
        let ours: [String: Any] = ["ok": true, "url": "https://Hotsauce.example.com/s/x", "anyone": true]
        guard case .shared = ScreenshotShare.parse(ours, expectedHost: "hotsauce.example.com") else { Issue.record("refused ours"); return }
    }

    @Test func theSizeCheckMatchesThePages() {
        #expect(ScreenshotShare.payload(Data([1, 2, 3])) == .success("AQID"))
        #expect(ScreenshotShare.payload(Data(count: ScreenshotShare.maxBytes + 1)) == .failure(.tooLarge))
        #expect(ScreenshotShare.maxBytes == 25 * 1024 * 1024)
    }
}

@Suite struct ScreenshotShortcutRulesTests {
    @Test func refusesChordsThatWouldGetInTheWay() {
        #expect(ScreenshotShortcut.default.refusal == nil)
        #expect(ScreenshotShortcut(keyCode: 1, modifiers: [.control, .option]).refusal == nil)
        #expect(ScreenshotShortcut(keyCode: 21, modifiers: []).refusal != nil) // a plain key
        #expect(ScreenshotShortcut(keyCode: 21, modifiers: [.shift]).refusal != nil)
        #expect(ScreenshotShortcut(keyCode: 8, modifiers: [.command]).refusal?.contains("⌘C") == true)
        #expect(ScreenshotShortcut(keyCode: 21, modifiers: [.command, .shift]).refusal?.contains("macOS") == true)
        #expect(ScreenshotShortcut(keyCode: 1, modifiers: [.command, .shift]).refusal == nil)
        #expect(ScreenshotShortcut(keyCode: 999, modifiers: [.option]).refusal != nil)
    }

    @Test func aRefusedSavedShortcutFallsBackToTheDefault() {
        let name = "screenshot-rules-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.set("⇧⌘4", forKey: ScreenshotSettings.shortcutKey)
        #expect(ScreenshotSettings.shortcut(defaults) == .default)
        defaults.removePersistentDomain(forName: name)
    }

    @Test func foldersReadWithATilde() {
        let home = URL(fileURLWithPath: "/Users/sam", isDirectory: true)
        #expect(ScreenshotSettings.displayPath(URL(fileURLWithPath: "/Users/sam/Pictures/Hotsauce Screenshots"), home: home) == "~/Pictures/Hotsauce Screenshots")
        #expect(ScreenshotSettings.displayPath(URL(fileURLWithPath: "/Volumes/Shots"), home: home) == "/Volumes/Shots")
        #expect(ScreenshotSettings.displayPath(URL(fileURLWithPath: "/Users/samantha/x"), home: home) == "/Users/samantha/x")
    }
}

@Suite struct ScreenshotAfterCaptureTests {
    @Test func everythingIsOnUntilTurnedOff() {
        let name = "screenshot-after-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        #expect(ScreenshotAfterCapture.load(defaults) == ScreenshotAfterCapture(copy: true, save: true, preview: true))
        ScreenshotAfterCapture(copy: true, save: false, preview: false).store(in: defaults)
        #expect(ScreenshotAfterCapture.load(defaults) == ScreenshotAfterCapture(copy: true, save: false, preview: false))
        defaults.removePersistentDomain(forName: name)
    }
}

@Suite struct ScreenshotSettingsBridgeTests {
    @Test func parsesTheScreenshotKeys() {
        #expect(MacSettingsBridge.parse(["type": "set", "key": "screenshotShortcut", "value": "⌃⌥S"]) == .set(.screenshotShortcut(ScreenshotShortcut(keyCode: 1, modifiers: [.control, .option]))))
        #expect(MacSettingsBridge.parse(["type": "set", "key": "screenshotShortcut", "value": "nonsense"]) == nil)
        #expect(MacSettingsBridge.parse(["type": "set", "key": "screenshotShortcut", "value": 4]) == nil)
        #expect(MacSettingsBridge.parse(["type": "set", "key": "screenshotCopy", "value": false]) == .set(.screenshotCopy(false)))
        #expect(MacSettingsBridge.parse(["type": "set", "key": "screenshotSave", "value": 0]) == nil)
        #expect(MacSettingsBridge.parse(["type": "set", "key": "screenshotPreview", "value": true]) == .set(.screenshotPreview(true)))
        for action in ["resetScreenshotShortcut", "chooseScreenshotFolder", "showScreenshotFolder"] {
            #expect(MacSettingsBridge.parse(["type": "action", "action": action]) != nil)
        }
    }

    @Test func theAnswerCarriesTheGroupOnlyWhenGiven() {
        var snapshot = MacSettingsBridge.Snapshot(
            hotkey: .rightOption, mode: .clean, edgeGlow: true, meetingReminders: true, offerCallNotes: true, callNotesSupported: true,
            openAtLogin: true, showInMenuBar: true, menuBarIconHidden: false, historyDays: 30, microphoneChoice: nil, microphones: [],
            microphone: true, accessibility: true, location: true, notifications: .on, connected: true, account: nil
        )
        #expect(snapshot.reply["screenshots"] == nil)
        snapshot.screenshots = .init(shortcut: .default, folder: "~/Pictures/Hotsauce Screenshots", afterCapture: ScreenshotAfterCapture(copy: true, save: false, preview: true))
        let group = snapshot.reply["screenshots"] as? [String: Any]
        #expect(group?["shortcut"] as? String == "⌥⇧4")
        #expect(group?["defaultShortcut"] as? String == "⌥⇧4")
        #expect(group?["folder"] as? String == "~/Pictures/Hotsauce Screenshots")
        #expect(group?["copy"] as? Bool == true)
        #expect(group?["save"] as? Bool == false)
        #expect(group?["preview"] as? Bool == true)
        #expect(snapshot.reply["hotkey"] as? String == "rightOption")
    }
}
