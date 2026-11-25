import Foundation
import Testing
@testable import DictateCore

// docs/PLAN-dictate-send-and-sounds.md

@Suite struct SendKeyTests {
    @Test func theSendKeyEndsARecordingAsASend() {
        var m = HotkeyStateMachine()
        #expect(m.send() == .none) // not recording: the key types as usual (R8)
        #expect(m.keyDown(at: 0) == .start)
        #expect(m.send() == .send)
        #expect(m.state == .idle)
        // Letting go of the dictation key afterwards does nothing more.
        #expect(m.keyUp(at: 1) == .none)
    }

    @Test func sendsHandsFreeToo() {
        var m = HotkeyStateMachine()
        _ = m.keyDown(at: 0)
        _ = m.keyUp(at: 0.1)
        _ = m.keyDown(at: 0.3)
        _ = m.keyUp(at: 0.4)
        #expect(m.state == .handsFree)
        #expect(m.send() == .send)
        #expect(!m.isRecording)
    }

    @Test func matchesItsKeysAndNotShortcuts() {
        #expect(SendKey.space.matches(keyCode: 49, flags: 0))
        // Space while holding Right ⌥ (the dictation key) still sends.
        #expect(SendKey.space.matches(keyCode: 49, flags: 0x0008_0000 | 0x40))
        #expect(!SendKey.space.matches(keyCode: 49, flags: 0x0010_0000)) // ⌘Space is Spotlight
        #expect(!SendKey.space.matches(keyCode: 49, flags: 0x0004_0000))
        #expect(SendKey.return.matches(keyCode: 36, flags: 0))
        #expect(SendKey.return.matches(keyCode: 76, flags: 0))
        #expect(SendKey.tab.matches(keyCode: 48, flags: 0))
        #expect(!SendKey.tab.matches(keyCode: 49, flags: 0))
        #expect(!SendKey.off.matches(keyCode: 49, flags: 0))
    }

    @Test func shiftSendsUnlessShiftIsTheDictationKey() {
        #expect(shiftSends(shiftHeld: true, hotkey: .rightOption))
        #expect(!shiftSends(shiftHeld: false, hotkey: .rightOption))
        #expect(!shiftSends(shiftHeld: true, hotkey: .rightShift))
    }

    @Test func remembersTheMembersChoices() throws {
        let defaults = try #require(UserDefaults(suiteName: "send-key-\(UUID())"))
        #expect(DictatePrefs.sendKey(defaults) == .space)
        #expect(DictatePrefs.sounds(defaults) == .soft)
        DictatePrefs.remember(sendKey: "return", sounds: "chime", in: defaults)
        #expect(DictatePrefs.sendKey(defaults) == .return)
        #expect(DictatePrefs.sounds(defaults) == .chime)
        // A server that predates them, or a value this app doesn't know, keeps the last ones.
        DictatePrefs.remember(sendKey: nil, sounds: "trumpet", in: defaults)
        #expect(DictatePrefs.sendKey(defaults) == .return)
        #expect(DictatePrefs.sounds(defaults) == .chime)
    }

    @Test func readsThemFromTheServer() throws {
        let body = #"{"speech":"online","cleanup":"fast","cleanupAvailable":true,"sendKey":"tab","sounds":"off"}"#
        let choices = try DictationClient.decodeChoices(status: 200, body: Data(body.utf8))
        #expect(choices.sendKey == "tab")
        #expect(choices.sounds == "off")
        let older = try DictationClient.decodeChoices(status: 200, body: Data(#"{"speech":"online","cleanup":"fast"}"#.utf8))
        #expect(older.sendKey == nil)
    }
}

@Suite struct DictateSoundsTests {
    @Test func everyThemeHasEveryMomentAndOffIsSilent() {
        for theme in SoundTheme.allCases {
            for event in SoundEvent.allCases {
                let tones = DictateSounds.tones(theme, event)
                if theme == .off {
                    #expect(tones.isEmpty)
                    #expect(DictateSounds.wav(theme, event) == nil)
                } else {
                    #expect(!tones.isEmpty)
                    #expect(DictateSounds.length(tones) <= 0.5)
                    #expect(DictateSounds.wav(theme, event) != nil)
                }
            }
        }
    }

    @Test func soundsAreTheSameEveryTimeAndStartAndEndQuietly() {
        let a = DictateSounds.render(DictateSounds.tones(.click, .send), sampleRate: 44_100)
        let b = DictateSounds.render(DictateSounds.tones(.click, .send), sampleRate: 44_100)
        #expect(a == b)
        #expect(a.count == Int((DictateSounds.length(DictateSounds.tones(.click, .send)) * 44_100).rounded(.up)))
        #expect(a.allSatisfy { abs($0) <= 1 })
        #expect(abs(a.first ?? 1) < 0.01)
        #expect(abs(a.last ?? 1) < 0.01)
        #expect((a.map { abs($0) }.max() ?? 0) > 0.05)
    }
}

@Suite struct QuietAudioTests {
    @Test func lowersOrMutesAndPutsItBack() {
        #expect(QuietAudio.off.quietVolume(from: 0.8) == nil)
        #expect(abs((QuietAudio.lower.quietVolume(from: 0.8) ?? 0) - 0.24) < 0.0001)
        #expect(QuietAudio.mute.quietVolume(from: 0.8) == 0)
        let quieted = QuietedVolume(original: 0.8, quiet: 0.24)
        #expect(quieted.restore(current: 0.24) == 0.8)
        // The member turned it up themselves meanwhile: theirs stays.
        #expect(quieted.restore(current: 0.6) == nil)
    }

    @Test func aVolumeLeftLoweredIsKeptForTheNextLaunch() throws {
        let defaults = try #require(UserDefaults(suiteName: "quiet-\(UUID())"))
        #expect(QuietedVolume.saved(defaults) == nil)
        QuietedVolume(original: 0.5, quiet: 0).save(defaults)
        #expect(QuietedVolume.saved(defaults) == QuietedVolume(original: 0.5, quiet: 0))
        QuietedVolume.clear(defaults)
        #expect(QuietedVolume.saved(defaults) == nil)
    }

    @Test func thisMacPageReadsAndSetsIt() {
        #expect(MacSettingsBridge.parse(["type": "set", "key": "quietAudio", "value": "lower"]) == .set(.quietAudio(.lower)))
        #expect(MacSettingsBridge.parse(["type": "set", "key": "quietAudio", "value": "loud"]) == nil)
        var snapshot = MacSettingsBridge.Snapshot(
            hotkey: .fn, mode: .clean, edgeGlow: true, meetingReminders: false, offerCallNotes: true, callNotesSupported: false,
            openAtLogin: false, showInMenuBar: true, menuBarIconHidden: false, historyDays: 30,
            microphoneChoice: nil, microphones: [],
            microphone: true, accessibility: true, location: true, notifications: .on, connected: true, account: nil
        )
        #expect(snapshot.reply["quietAudio"] as? String == "off")
        snapshot.quietAudio = .mute
        #expect(snapshot.reply["quietAudio"] as? String == "mute")
    }
}

@Suite struct EarlyWarningTests {
    @Test func saysOnceWhenTheMicHearsNothing() {
        var watch = SilenceWatch(startedAt: 10)
        let r1 = watch.push(level: 0, at: 10.5)
        #expect(!r1)
        let r2 = watch.push(level: 0.001, at: 12)
        #expect(!r2)
        let r3 = watch.push(level: 0, at: 12.6)
        #expect(r3)
        let r4 = watch.push(level: 0, at: 13)
        #expect(!r4)
    }

    @Test func aMicThatHearsTheRoomIsFine() {
        var watch = SilenceWatch(startedAt: 0)
        let r5 = watch.push(level: 0.01, at: 0.2)
        #expect(!r5)
        let r6 = watch.push(level: 0, at: 3)
        #expect(!r6)
        let r7 = watch.push(level: 0, at: 9)
        #expect(!r7)
    }
}
