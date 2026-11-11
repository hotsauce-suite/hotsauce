import Testing
@testable import DictateCore

@Suite struct HotkeyStateMachineTests {
    @Test func holdToTalk() {
        var m = HotkeyStateMachine()
        #expect(m.keyDown(at: 0) == .start)
        #expect(m.isRecording)
        #expect(m.keyDown(at: 0.2) == .none) // key repeat
        #expect(m.keyUp(at: 1.5) == .finish)
        #expect(m.state == .idle)
    }

    @Test func aShortTapIsIgnored() {
        var m = HotkeyStateMachine()
        #expect(m.keyDown(at: 0) == .start)
        #expect(m.keyUp(at: 0.2) == .cancel)
        #expect(!m.isRecording)
        // Long after: a fresh hold, not hands-free.
        #expect(m.keyDown(at: 5) == .start)
        #expect(m.state == .holding(since: 5))
    }

    @Test func doubleTapIsHandsFreeUntilTappedAgain() {
        var m = HotkeyStateMachine()
        #expect(m.keyDown(at: 0) == .start)
        #expect(m.keyUp(at: 0.1) == .cancel)
        #expect(m.keyDown(at: 0.3) == .start)
        #expect(m.state == .handsFree)
        #expect(m.keyUp(at: 0.4) == .none)
        #expect(m.isRecording)
        #expect(m.keyDown(at: 9) == .finish)
        #expect(m.state == .idle)
        #expect(m.keyUp(at: 9.1) == .none)
    }

    @Test func escapeCancelsHoldingAndHandsFree() {
        var m = HotkeyStateMachine()
        _ = m.keyDown(at: 0)
        #expect(m.escape() == .cancel)
        #expect(m.keyUp(at: 2) == .none)
        _ = m.keyDown(at: 3)
        _ = m.keyUp(at: 3.1)
        _ = m.keyDown(at: 3.2)
        #expect(m.escape() == .cancel)
        #expect(m.state == .idle)
        #expect(m.escape() == .none) // not recording: Esc goes to the app
    }

    @Test func aShortcutWhileHoldingIsNotADictation() {
        var m = HotkeyStateMachine()
        _ = m.keyDown(at: 0)
        #expect(m.otherKeyDown() == .cancel)
        #expect(m.keyUp(at: 2) == .none)
        _ = m.keyDown(at: 3)
        _ = m.keyUp(at: 3.1)
        #expect(m.otherKeyDown() == .none)
        #expect(m.keyDown(at: 3.2) == .start)
        #expect(m.state == .holding(since: 3.2)) // the typing broke the double-tap
    }

    @Test func typingDuringHandsFreeKeepsRecording() {
        var m = HotkeyStateMachine()
        _ = m.keyDown(at: 0); _ = m.keyUp(at: 0.1); _ = m.keyDown(at: 0.2)
        #expect(m.otherKeyDown() == .none)
        #expect(m.state == .handsFree)
    }

    @Test func modifierEventsAreReadFromTheDeviceBits() {
        // Right option down while left option is also held, then up while left stays down.
        let leftAndRight: UInt64 = 0x80000 | 0x20 | 0x40
        let leftOnly: UInt64 = 0x80000 | 0x20
        #expect(Hotkey.rightOption.isDown(keyCode: 61, flags: leftAndRight) == true)
        #expect(Hotkey.rightOption.isDown(keyCode: 61, flags: leftOnly) == false)
        #expect(Hotkey.rightOption.isDown(keyCode: 58, flags: leftAndRight) == nil) // left option key
        #expect(Hotkey.rightCommand.isDown(keyCode: 54, flags: 0x100000 | 0x10) == true)
        #expect(Hotkey.fn.isDown(keyCode: 63, flags: 0x800000) == true)
        #expect(Hotkey.fn.isDown(keyCode: 63, flags: 0) == false)
    }
}
