import Foundation
import Testing
@testable import DictateCore

// docs/PLAN-one-settings.md R9 and R11.
@Suite struct MacSettingsBridgeTests {
    @Test func readsHelloGetAndActions() {
        #expect(MacSettingsBridge.parse(["type": "hello"]) == .hello)
        #expect(MacSettingsBridge.parse(["type": "get"]) == .get)
        for action in MacSettingsBridge.Action.allCases {
            #expect(MacSettingsBridge.parse(["type": "action", "action": action.rawValue]) == .action(action))
        }
        #expect(MacSettingsBridge.parse(["type": "action", "action": "deleteEverything"]) == nil)
    }

    @Test func readsEachSettingWithItsKindOfValue() {
        func set(_ key: String, _ value: Any) -> MacSettingsBridge.Request? {
            MacSettingsBridge.parse(["type": "set", "key": key, "value": value])
        }
        #expect(set("hotkey", "fn") == .set(.hotkey(.fn)))
        #expect(set("mode", "literal") == .set(.mode(.literal)))
        #expect(set("edgeGlow", NSNumber(value: false)) == .set(.edgeGlow(false)))
        #expect(set("meetingReminders", NSNumber(value: true)) == .set(.meetingReminders(true)))
        #expect(set("offerCallNotes", NSNumber(value: true)) == .set(.offerCallNotes(true)))
        #expect(set("openAtLogin", NSNumber(value: true)) == .set(.openAtLogin(true)))
        #expect(set("showInMenuBar", NSNumber(value: false)) == .set(.showInMenuBar(false)))
        #expect(set("historyDays", NSNumber(value: 7)) == .set(.historyDays(7)))
        #expect(set("historyDays", NSNumber(value: 90.0)) == .set(.historyDays(90)))
        #expect(set("microphone", "BuiltInMicrophoneDevice") == .set(.microphone("BuiltInMicrophoneDevice")))
        #expect(set("microphone", NSNull()) == .set(.microphone(nil)))
    }

    @Test func refusesAnythingElse() {
        let bad: [Any] = [
            "get",
            ["type": "get", "extra": 1],
            ["type": "set", "key": "hotkey", "value": "leftOption"],
            ["type": "set", "key": "mode", "value": "loud"],
            ["type": "set", "key": "edgeGlow", "value": NSNumber(value: 1)],
            ["type": "set", "key": "edgeGlow", "value": "true"],
            ["type": "set", "key": "historyDays", "value": NSNumber(value: 14)],
            ["type": "set", "key": "historyDays", "value": NSNumber(value: 7.5)],
            ["type": "set", "key": "historyDays", "value": NSNumber(value: true)],
            ["type": "set", "key": "suiteServer", "value": "https://evil.example"],
            ["type": "set", "key": "hotkey"],
            ["type": "set", "key": "microphone", "value": ""],
            ["type": "set", "key": "microphone", "value": NSNumber(value: 3)],
            ["type": "delete"],
        ]
        for body in bad { #expect(MacSettingsBridge.parse(body) == nil) }
    }

    @Test func theSnapshotIsWhatThePageParses() {
        let snapshot = MacSettingsBridge.Snapshot(
            hotkey: .rightShift, mode: .clean, edgeGlow: true, meetingReminders: false, offerCallNotes: true, callNotesSupported: false,
            openAtLogin: false, showInMenuBar: true, menuBarIconHidden: true, historyDays: 30,
            microphoneChoice: "usb-1", microphones: [.init(id: "usb-1", name: "USB Mic")],
            microphone: true, accessibility: false, location: true, notifications: .undecided, account: nil
        )
        let reply = snapshot.reply
        #expect(reply["hotkey"] as? String == "rightShift")
        #expect(reply["historyDays"] as? Int == 30)
        #expect(reply["callNotesSupported"] as? Bool == false)
        #expect(reply["account"] is NSNull)
        let permissions = reply["permissions"] as? [String: Any]
        #expect(permissions?["notifications"] as? String == "undecided")
        #expect(permissions?["accessibility"] as? Bool == false)
        #expect(reply["microphoneChoice"] as? String == "usb-1")
        #expect((reply["microphones"] as? [[String: String]])?.first?["name"] == "USB Mic")
        #expect(JSONSerialization.isValidJSONObject(reply))
    }

    @Test func commaOpensThisMacOnlyWhenThePageHasIt() {
        #expect(SettingsDestination.choose(pageSaidHello: true, pageLoaded: true) == .thisMacPage)
        #expect(SettingsDestination.choose(pageSaidHello: false, pageLoaded: true) == .fallbackWindow)
        #expect(SettingsDestination.choose(pageSaidHello: true, pageLoaded: false) == .fallbackWindow)
    }
}
