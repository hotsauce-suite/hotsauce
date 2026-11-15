import CoreGraphics
import Foundation
import Testing
@testable import DictateCore

@Suite struct EdgeGlowGeometryTests {
    // A 1512×982 laptop screen as the primary, with a 2560×1440 monitor above and to the left.
    let laptop = CGRect(x: 0, y: 0, width: 1512, height: 982)
    let monitor = CGRect(x: -800, y: 982, width: 2560, height: 1440)

    @Test func convertsTopLeftWindowFramesToCocoa() {
        // AX: 100 from the left, 50 down from the primary screen's top, 800×600.
        let frame = EdgeGlowGeometry.cocoaFrame(axPosition: CGPoint(x: 100, y: 50), axSize: CGSize(width: 800, height: 600), primaryScreenHeight: 982)
        #expect(frame == CGRect(x: 100, y: 332, width: 800, height: 600))
    }

    @Test func convertsWindowsOnAScreenAboveThePrimary() {
        // A window near the top of the monitor has a negative AX y.
        let frame = EdgeGlowGeometry.cocoaFrame(axPosition: CGPoint(x: -700, y: -1400), axSize: CGSize(width: 1000, height: 700), primaryScreenHeight: 982)
        #expect(frame == CGRect(x: -700, y: 1682, width: 1000, height: 700))
        #expect(monitor.contains(frame))
    }

    @Test func framesTheFocusedWindow() {
        let window = CGRect(x: 100, y: 332, width: 800, height: 600)
        let placed = EdgeGlowGeometry.placement(window: window, screens: [laptop, monitor], mouse: CGPoint(x: 5, y: 5))
        #expect(placed == EdgeGlowGeometry.Placement(frame: window, isScreen: false))
    }

    @Test func trimsAWindowHangingOffItsScreen() throws {
        let window = CGRect(x: 1200, y: 300, width: 800, height: 600)
        let placed = try #require(EdgeGlowGeometry.placement(window: window, screens: [laptop, monitor], mouse: .zero))
        #expect(placed.frame == CGRect(x: 1200, y: 300, width: 312, height: 600))
        #expect(!placed.isScreen)
    }

    @Test func fallsBackToThePointersScreenWithoutAWindow() {
        let mouse = CGPoint(x: 0, y: 2000)
        #expect(EdgeGlowGeometry.placement(window: nil, screens: [laptop, monitor], mouse: mouse) == .init(frame: monitor, isScreen: true))
        #expect(EdgeGlowGeometry.placement(window: nil, screens: [laptop, monitor], mouse: CGPoint(x: 9_999, y: 9_999)) == .init(frame: laptop, isScreen: true))
    }

    @Test func fallsBackForFullScreenTinyAndOffscreenWindows() {
        let mouse = CGPoint(x: 10, y: 10)
        let screen = EdgeGlowGeometry.Placement(frame: laptop, isScreen: true)
        #expect(EdgeGlowGeometry.placement(window: laptop, screens: [laptop, monitor], mouse: mouse) == screen)
        // A full-screen app's window can sit a point or two off the screen's edges.
        #expect(EdgeGlowGeometry.placement(window: laptop.insetBy(dx: 1, dy: 1), screens: [laptop], mouse: mouse) == screen)
        #expect(EdgeGlowGeometry.placement(window: CGRect(x: 10, y: 10, width: 60, height: 40), screens: [laptop], mouse: mouse) == screen)
        #expect(EdgeGlowGeometry.placement(window: CGRect(x: 5000, y: 5000, width: 800, height: 600), screens: [laptop], mouse: mouse) == screen)
    }

    @Test func noScreensMeansNothingToFrame() {
        #expect(EdgeGlowGeometry.placement(window: nil, screens: [], mouse: .zero) == nil)
    }
}

@Suite struct EdgeGlowLevelTests {
    @Test func mapsLikeThePillsMeter() {
        #expect(EdgeGlowLevel.normalized(0) == 0)
        #expect(EdgeGlowLevel.normalized(1) == 1)
        #expect(abs(EdgeGlowLevel.normalized(0.04) - 0.44) < 0.001)
        #expect(EdgeGlowLevel.normalized(-1) == 0)
    }

    @Test func risesFastAndFallsSlowly() {
        var level = EdgeGlowLevel()
        level.target(raw: 1)
        level.step(dt: 1.0 / 60)
        let afterOneFrameUp = level.value
        #expect(afterOneFrameUp > 0.3)
        for _ in 0..<30 { level.step(dt: 1.0 / 60) }
        #expect(level.value > 0.97)
        level.target(raw: 0)
        level.step(dt: 1.0 / 60)
        // A frame of silence takes off much less than a frame of speech added.
        #expect(1 - level.value < afterOneFrameUp / 3)
        for _ in 0..<120 { level.step(dt: 1.0 / 60) }
        #expect(level.value < 0.05)
    }

    @Test func aLongPauseBetweenFramesDoesNotOvershoot() {
        var level = EdgeGlowLevel()
        level.target(raw: 0.5)
        level.step(dt: 5)
        #expect(level.value <= EdgeGlowLevel.normalized(0.5))
        #expect(level.value > 0.99 * EdgeGlowLevel.normalized(0.5))
    }

    @Test func resetGoesBackToSilence() {
        var level = EdgeGlowLevel()
        level.target(raw: 1)
        level.step(dt: 1)
        level.reset()
        #expect(level.value == 0)
        level.step(dt: 1)
        #expect(level.value == 0)
    }
}

@Suite struct EdgeGlowMachineTests {
    @Test func listensThinksAndFades() {
        var m = EdgeGlowMachine()
        #expect(m.phase == .idle)
        #expect(m.handle(.listen) == .listening)
        #expect(m.handle(.think) == .thinking)
        #expect(m.handle(.finish) == .fading)
        #expect(m.handle(.faded) == .idle)
    }

    @Test func cancellingWhileListeningFades() {
        var m = EdgeGlowMachine()
        _ = m.handle(.listen)
        #expect(m.handle(.finish) == .fading)
    }

    @Test func aRetryWithoutListeningShowsNothing() {
        var m = EdgeGlowMachine()
        #expect(m.handle(.think) == nil)
        #expect(m.handle(.finish) == nil)
        #expect(m.phase == .idle)
    }

    @Test func aNewDictationDuringTheFadeListensAgain() {
        var m = EdgeGlowMachine()
        _ = m.handle(.listen)
        _ = m.handle(.finish)
        #expect(m.handle(.listen) == .listening)
        // The old fade's completion arriving late changes nothing.
        #expect(m.handle(.faded) == nil)
        #expect(m.phase == .listening)
    }

    @Test func repeatsAreIgnored() {
        var m = EdgeGlowMachine()
        _ = m.handle(.listen)
        #expect(m.handle(.listen) == nil)
        _ = m.handle(.think)
        #expect(m.handle(.think) == nil)
        #expect(m.handle(.listen) == nil) // thinking can't go back to listening
        _ = m.handle(.finish)
        #expect(m.handle(.finish) == nil)
    }
}

@Suite struct EdgeGlowLookTests {
    @Test func flamesGrowWithTheVoiceAndStayInTheWindow() {
        let rest = EdgeGlowLook.flameHeight(level: 0, windowHeight: 800)
        let loud = EdgeGlowLook.flameHeight(level: 1, windowHeight: 800)
        #expect(rest == EdgeGlowLook.flameRest)
        #expect(loud == EdgeGlowLook.flameRest + EdgeGlowLook.flameRise)
        #expect(EdgeGlowLook.flameHeight(level: 0.5, windowHeight: 800) > rest)
        #expect(EdgeGlowLook.flameHeight(level: 0.5, windowHeight: 800) < loud)
        // A short window caps the flames at a third of its height.
        #expect(EdgeGlowLook.flameHeight(level: 1, windowHeight: 150) == 50)
        #expect(EdgeGlowLook.flameHeight(level: 7, windowHeight: 800) == loud)
    }

    @Test func reduceMotionIsStatic() {
        #expect(EdgeGlowLook.animates(reduceMotion: false))
        #expect(!EdgeGlowLook.animates(reduceMotion: true))
    }

    @Test func theFadeIsAQuarterSecond() {
        #expect(EdgeGlowLook.fadeOut == 0.25)
    }
}

@Suite struct EdgeGlowSettingTests {
    @Test func onByDefaultAndRemembered() throws {
        let defaults = try #require(UserDefaults(suiteName: "edge-glow-tests-\(UUID().uuidString)"))
        #expect(EdgeGlowSetting.isOn(defaults))
        EdgeGlowSetting.set(false, in: defaults)
        #expect(!EdgeGlowSetting.isOn(defaults))
        EdgeGlowSetting.set(true, in: defaults)
        #expect(EdgeGlowSetting.isOn(defaults))
        #expect(defaults.object(forKey: EdgeGlowSetting.key) as? Bool == true)
    }
}
