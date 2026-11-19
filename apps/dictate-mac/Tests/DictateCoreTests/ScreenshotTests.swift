import CoreGraphics
import Foundation
import Testing
@testable import DictateCore

// docs/PLAN-screenshots.md R7 to R10 (slice 2).

@Suite struct ScreenshotShortcutTests {
    let shift: UInt64 = 0x0002_0000
    let control: UInt64 = 0x0004_0000
    let option: UInt64 = 0x0008_0000
    let command: UInt64 = 0x0010_0000

    @Test func theDefaultIsOptionShift4() {
        #expect(ScreenshotShortcut.default.display == "⌥⇧4")
        #expect(ScreenshotShortcut.default.keyCode == 21)
        #expect(ScreenshotShortcut.default.isUsable)
    }

    @Test func showsModifiersInApplesOrder() {
        let all = ScreenshotShortcut(keyCode: 1, modifiers: [.command, .shift, .option, .control])
        #expect(all.display == "⌃⌥⇧⌘S")
        #expect(ScreenshotShortcut(keyCode: 49, modifiers: [.control]).display == "⌃Space")
        #expect(ScreenshotShortcut(keyCode: 122, modifiers: [.command]).display == "⌘F1")
    }

    @Test func parsesWhatItShows() {
        for shortcut in [
            ScreenshotShortcut.default,
            ScreenshotShortcut(keyCode: 1, modifiers: [.command, .shift, .option, .control]),
            ScreenshotShortcut(keyCode: 49, modifiers: [.control]),
            ScreenshotShortcut(keyCode: 111, modifiers: [.option]),
            ScreenshotShortcut(keyCode: 47, modifiers: [.command]),
        ] {
            #expect(ScreenshotShortcut(parsing: shortcut.display) == shortcut)
        }
    }

    @Test func parsingIgnoresModifierOrderAndLetterCase() {
        #expect(ScreenshotShortcut(parsing: "⇧⌥4") == .default)
        #expect(ScreenshotShortcut(parsing: "⌘⇧s") == ScreenshotShortcut(keyCode: 1, modifiers: [.command, .shift]))
        #expect(ScreenshotShortcut(parsing: " ⌃space ")?.keyCode == 49)
    }

    @Test func refusesTextThatIsNotAChord() {
        #expect(ScreenshotShortcut(parsing: "") == nil)
        #expect(ScreenshotShortcut(parsing: "⌥⇧") == nil)
        #expect(ScreenshotShortcut(parsing: "⌥⇧44") == nil)
        #expect(ScreenshotShortcut(parsing: "⌥⇧£") == nil)
    }

    @Test func needsCommandOptionOrControl() {
        #expect(!ScreenshotShortcut(keyCode: 21, modifiers: [.shift]).isUsable)
        #expect(!ScreenshotShortcut(keyCode: 21, modifiers: []).isUsable)
        #expect(ScreenshotShortcut(keyCode: 21, modifiers: [.control]).isUsable)
        #expect(!ScreenshotShortcut(keyCode: 999, modifiers: [.command]).isUsable)
    }

    @Test func matchesExactlyItsModifiers() {
        let s = ScreenshotShortcut.default
        #expect(s.matches(keyCode: 21, flags: option | shift))
        #expect(!s.matches(keyCode: 21, flags: option))
        #expect(!s.matches(keyCode: 21, flags: option | shift | command))
        #expect(!s.matches(keyCode: 20, flags: option | shift))
        #expect(!s.matches(keyCode: 21, flags: 0))
    }

    @Test func caps_lock_fn_and_left_right_bits_are_noise() {
        let s = ScreenshotShortcut.default
        let capsLock: UInt64 = 0x0001_0000
        let fn: UInt64 = 0x0080_0000
        let numericPad: UInt64 = 0x0020_0000
        let rightOption: UInt64 = 0x40
        let leftShift: UInt64 = 0x02
        let nonCoalesced: UInt64 = 0x0000_0100
        #expect(s.matches(keyCode: 21, flags: option | shift | capsLock | fn | numericPad | rightOption | leftShift | nonCoalesced))
        let arrow = ScreenshotShortcut(keyCode: 126, modifiers: [.control, .option])
        #expect(arrow.matches(keyCode: 126, flags: control | option | fn | numericPad))
    }

    @Test func storesAsItsText() throws {
        let data = try JSONEncoder().encode(ScreenshotShortcut.default)
        #expect(String(decoding: data, as: UTF8.self) == "\"⌥⇧4\"")
        #expect(try JSONDecoder().decode(ScreenshotShortcut.self, from: data) == .default)
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(ScreenshotShortcut.self, from: Data("\"nope\"".utf8)) }
    }

    @Test func menuKeyEquivalentIsTheKeysCharacter() {
        #expect(ScreenshotShortcut.default.keyEquivalent == "4")
        #expect(ScreenshotShortcut(keyCode: 1, modifiers: [.command]).keyEquivalent == "s")
        #expect(ScreenshotShortcut(keyCode: 49, modifiers: [.command]).keyEquivalent == nil)
        #expect(ScreenshotShortcut(keyCode: 36, modifiers: [.command]).keyEquivalent == nil)
    }
}

@Suite struct ScreenshotSettingsTests {
    func defaults() -> UserDefaults {
        let name = "screenshot-settings-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    @Test func shortcutDefaultsToOptionShift4AndRemembersAChange() {
        let d = defaults()
        #expect(ScreenshotSettings.shortcut(d) == .default)
        let other = ScreenshotShortcut(keyCode: 1, modifiers: [.command, .shift])
        ScreenshotSettings.setShortcut(other, in: d)
        #expect(d.string(forKey: ScreenshotSettings.shortcutKey) == "⇧⌘S")
        #expect(ScreenshotSettings.shortcut(d) == other)
    }

    @Test func anUnusableSavedShortcutFallsBack() {
        let d = defaults()
        d.set("⇧4", forKey: ScreenshotSettings.shortcutKey)
        #expect(ScreenshotSettings.shortcut(d) == .default)
        d.set("garbage", forKey: ScreenshotSettings.shortcutKey)
        #expect(ScreenshotSettings.shortcut(d) == .default)
    }

    @Test func folderDefaultsToPicturesAndCanMove() {
        let d = defaults()
        let home = URL(fileURLWithPath: "/Users/someone", isDirectory: true)
        #expect(ScreenshotSettings.folder(d, home: home).path == "/Users/someone/Pictures/Hotsauce Screenshots")
        ScreenshotSettings.setFolder(URL(fileURLWithPath: "/Volumes/Shots"), in: d)
        #expect(ScreenshotSettings.folder(d, home: home).path == "/Volumes/Shots")
    }
}

@Suite struct CaptureGeometryTests {
    // A Retina laptop as the main display, and a 1× monitor above it and to the left (negative origin).
    let laptop = CaptureDisplay(id: 1, frame: CGRect(x: 0, y: 0, width: 1512, height: 982), pixelWidth: 3024, pixelHeight: 1964)
    let monitor = CaptureDisplay(id: 2, frame: CGRect(x: -800, y: -1440, width: 2560, height: 1440), pixelWidth: 2560, pixelHeight: 1440)
    // A "looks like 1800×1169" mode on a 2880×1864 panel: backing 3600×2338, but captured at panel size.
    let scaled = CaptureDisplay(id: 3, frame: CGRect(x: 1512, y: 0, width: 1800, height: 1165), pixelWidth: 2880, pixelHeight: 1864)

    @Test func aDragIsNormalisedWhicheverWayItGoes() {
        let expected = CGRect(x: 100, y: 50, width: 200, height: 80)
        #expect(CaptureGeometry.dragRect(from: CGPoint(x: 100, y: 50), to: CGPoint(x: 300, y: 130)) == expected)
        #expect(CaptureGeometry.dragRect(from: CGPoint(x: 300, y: 130), to: CGPoint(x: 100, y: 50)) == expected)
        #expect(CaptureGeometry.dragRect(from: CGPoint(x: 300, y: 50), to: CGPoint(x: 100, y: 130)) == expected)
    }

    @Test func aTinyDragIsAClick() {
        #expect(CaptureGeometry.isClick(from: CGPoint(x: 10, y: 10), to: CGPoint(x: 13, y: 12.5)))
        #expect(!CaptureGeometry.isClick(from: CGPoint(x: 10, y: 10), to: CGPoint(x: 14, y: 10)))
        #expect(!CaptureGeometry.isClick(from: CGPoint(x: 10, y: 10), to: CGPoint(x: 10, y: 5)))
    }

    @Test func retinaPixelsAreTwicePoints() {
        let pixels = laptop.pixelRect(for: CGRect(x: 10, y: 20, width: 100, height: 50))
        #expect(pixels == CGRect(x: 20, y: 40, width: 200, height: 100))
        #expect(laptop.pixelSize(of: CGRect(x: 10, y: 20, width: 100, height: 50)) == (200, 100))
    }

    @Test func fractionalScalesRoundOutToWholePixels() {
        // 2880 / 1800 = 1.6 pixels a point.
        #expect(scaled.scaleX == 1.6)
        let pixels = scaled.pixelRect(for: CGRect(x: 1512 + 10.3, y: 0.3, width: 100, height: 50))
        // 10.3 × 1.6 = 16.48 → 16; 110.3 × 1.6 = 176.48 → 177.
        #expect(pixels == CGRect(x: 16, y: 0, width: 161, height: 81))
        // Exactly on pixel edges stays exact despite floating point.
        #expect(scaled.pixelRect(for: CGRect(x: 1512 + 5, y: 5, width: 5, height: 5)) == CGRect(x: 8, y: 8, width: 8, height: 8))
    }

    @Test func negativeOriginsAreLocalToTheirDisplay() {
        let pixels = monitor.pixelRect(for: CGRect(x: -700, y: -1400, width: 300, height: 200))
        #expect(pixels == CGRect(x: 100, y: 40, width: 300, height: 200))
        #expect(monitor.pixelPoint(for: CGPoint(x: -800, y: -1440)) == (0, 0))
        #expect(monitor.pixelPoint(for: CGPoint(x: 1760, y: 0)) == (2559, 1439))
    }

    @Test func selectionsAreClampedToTheDisplay() {
        let pixels = laptop.pixelRect(for: CGRect(x: 1400, y: 900, width: 500, height: 500))
        #expect(pixels == CGRect(x: 2800, y: 1800, width: 224, height: 164))
        #expect(laptop.pixelRect(for: CGRect(x: 2000, y: 0, width: 10, height: 10)) == nil)
        #expect(laptop.pixelRect(for: CGRect(x: 10, y: 10, width: 0, height: 10)) == nil)
    }

    let windows = [
        CaptureWindow(id: 9, frame: CGRect(x: 0, y: 0, width: 1512, height: 25), layer: 24, ownerPID: 100, ownerName: "Window Server"),
        CaptureWindow(id: 8, frame: CGRect(x: 300, y: 900, width: 900, height: 80), layer: 20, ownerPID: 101, ownerName: "Dock"),
        CaptureWindow(id: 7, frame: CGRect(x: 1300, y: 40, width: 200, height: 300), layer: 3, ownerPID: 102, ownerName: "Notes"),
        CaptureWindow(id: 6, frame: CGRect(x: 100, y: 100, width: 600, height: 400), layer: 0, ownerPID: 103, ownerName: "Safari"),
        CaptureWindow(id: 5, frame: CGRect(x: 200, y: 200, width: 800, height: 600), layer: 0, ownerPID: 104, ownerName: "Mail"),
        CaptureWindow(id: 4, frame: CGRect(x: 50, y: 50, width: 400, height: 300), layer: 0, ownerPID: 999, ownerName: "Hotsauce"),
        CaptureWindow(id: 3, frame: CGRect(x: 600, y: 600, width: 100, height: 100), layer: 0, ownerPID: 105, ownerName: "Ghost", alpha: 0),
        CaptureWindow(id: 2, frame: CGRect(x: 500, y: 500, width: 10, height: 300), layer: 0, ownerPID: 106, ownerName: "Sliver"),
        CaptureWindow(id: 1, frame: CGRect(x: 0, y: 0, width: 1512, height: 982), layer: -2147483623, ownerPID: 101, ownerName: "Dock"),
    ]

    @Test func onlyOtherAppsOrdinaryWindowsArePickable() {
        let pickable = CaptureGeometry.pickableWindows(windows, ownPID: 999)
        #expect(pickable.map(\.id) == [7, 6, 5])
    }

    @Test func picksTheFrontmostWindowUnderThePointer() {
        let pickable = CaptureGeometry.pickableWindows(windows, ownPID: 999)
        #expect(CaptureGeometry.window(at: CGPoint(x: 250, y: 250), in: pickable)?.id == 6)
        #expect(CaptureGeometry.window(at: CGPoint(x: 900, y: 700), in: pickable)?.id == 5)
        #expect(CaptureGeometry.window(at: CGPoint(x: 1400, y: 100), in: pickable)?.id == 7)
        #expect(CaptureGeometry.window(at: CGPoint(x: 60, y: 60), in: pickable) == nil)
    }

    @Test func aClickOnAWindowPicksItsFrame() {
        let pickable = CaptureGeometry.pickableWindows(windows, ownPID: 999)
        let pick = CaptureGeometry.selection(from: CGPoint(x: 250, y: 250), to: CGPoint(x: 252, y: 251), windows: pickable, display: laptop)
        #expect(pick == CaptureSelection(kind: .window(6), rect: CGRect(x: 100, y: 100, width: 600, height: 400)))
    }

    @Test func aWindowHangingOffTheDisplayIsTrimmed() {
        let wide = [CaptureWindow(id: 1, frame: CGRect(x: 1200, y: 100, width: 800, height: 400), layer: 0, ownerPID: 5, ownerName: "Maps")]
        let pick = CaptureGeometry.hover(at: CGPoint(x: 1300, y: 200), windows: wide, display: laptop)
        #expect(pick == CaptureSelection(kind: .window(1), rect: CGRect(x: 1200, y: 100, width: 312, height: 400)))
    }

    @Test func aClickOnTheDesktopPicksTheWholeDisplay() {
        let pickable = CaptureGeometry.pickableWindows(windows, ownPID: 999)
        let pick = CaptureGeometry.selection(from: CGPoint(x: 1450, y: 800), to: CGPoint(x: 1450, y: 800), windows: pickable, display: laptop)
        #expect(pick == CaptureSelection(kind: .display, rect: laptop.frame))
        let other = CaptureGeometry.selection(from: CGPoint(x: -100, y: -100), to: CGPoint(x: -100, y: -100), windows: pickable, display: monitor)
        #expect(other == CaptureSelection(kind: .display, rect: monitor.frame))
    }

    @Test func aDragIsAnAreaEvenOverWindowsAndStaysOnItsDisplay() {
        let pickable = CaptureGeometry.pickableWindows(windows, ownPID: 999)
        let pick = CaptureGeometry.selection(from: CGPoint(x: 1400, y: 900), to: CGPoint(x: 1700, y: 1100), windows: pickable, display: laptop)
        #expect(pick == CaptureSelection(kind: .area, rect: CGRect(x: 1400, y: 900, width: 112, height: 82)))
    }

    @Test func flipsBetweenAppKitAndTopLeftCoordinates() {
        // The main display is 982 points tall; the monitor sits above it in AppKit (y 982…2422).
        #expect(CaptureGeometry.flipped(CGPoint(x: 10, y: 972), mainDisplayHeight: 982) == CGPoint(x: 10, y: 10))
        let appKitMonitor = CGRect(x: -800, y: 982, width: 2560, height: 1440)
        #expect(CaptureGeometry.flipped(appKitMonitor, mainDisplayHeight: 982) == monitor.frame)
        #expect(CaptureGeometry.flipped(monitor.frame, mainDisplayHeight: 982) == appKitMonitor)
    }
}

@Suite struct ScreenshotImageTests {
    /// A 4×2 pixel image of a 2×1 point Retina display: each pixel a different red value.
    func image() throws -> CGImage {
        var bytes: [UInt8] = []
        for index in 0..<8 { bytes += [UInt8(index * 30), 0, 0, 255] }
        let context = try #require(CGContext(
            data: &bytes, width: 4, height: 2, bitsPerComponent: 8, bytesPerRow: 16,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        return try #require(context.makeImage())
    }

    func reds(_ image: CGImage) throws -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
        let context = try #require(CGContext(
            data: &bytes, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return stride(from: 0, to: bytes.count, by: 4).map { bytes[$0] }
    }

    @Test func cropsTheFrozenFrameInPixels() throws {
        // The display sits at a negative origin: its right point is pixels 2…3 of both rows.
        let display = CaptureDisplay(id: 1, frame: CGRect(x: -2, y: -1, width: 2, height: 1), pixelWidth: 4, pixelHeight: 2)
        let crop = try #require(ScreenshotImage.crop(try image(), display: display, to: CGRect(x: -1, y: -1, width: 1, height: 1)))
        #expect(crop.width == 2 && crop.height == 2)
        #expect(try reds(crop) == [60, 90, 180, 210])
    }

    @Test func makesAPNG() throws {
        let png = try #require(ScreenshotImage.png(try image()))
        #expect(png.starts(with: [0x89, 0x50, 0x4E, 0x47]))
    }
}

@Suite struct ScreenshotFilesTests {
    let utc = TimeZone(identifier: "UTC")!
    // 2026-11-19 14:03:09 UTC.
    let date = Date(timeIntervalSince1970: 1_795_096_989)

    @Test func namesLikeMacOSDoes() {
        #expect(ScreenshotFiles.baseName(for: date, timeZone: utc) == "Screenshot 2026-11-19 at 14.03.09")
        #expect(ScreenshotFiles.fileName(for: date, timeZone: utc) { _ in false } == "Screenshot 2026-11-19 at 14.03.09.png")
    }

    @Test func usesTheMembersTimeZone() {
        let tokyo = TimeZone(identifier: "Asia/Tokyo")!
        #expect(ScreenshotFiles.baseName(for: date, timeZone: tokyo) == "Screenshot 2026-11-19 at 23.03.09")
    }

    @Test func numbersAShotOfTheSameSecond() {
        let taken: Set = ["Screenshot 2026-11-19 at 14.03.09.png", "Screenshot 2026-11-19 at 14.03.09 2.png"]
        #expect(ScreenshotFiles.fileName(for: date, timeZone: utc) { taken.contains($0) } == "Screenshot 2026-11-19 at 14.03.09 3.png")
    }
}

@Suite struct RecentCapturesTests {
    @Test func keepsTheNewestFive() {
        var recent = RecentCaptures<Int>()
        #expect(recent.newest == nil)
        for n in 1...7 { recent.add(n) }
        #expect(recent.items == [7, 6, 5, 4, 3])
        #expect(recent.newest == 7)
    }
}

@Suite struct ScreenshotSessionTests {
    @Test func theShortcutStartsThenDismisses() {
        var s = ScreenshotSession()
        #expect(s.shortcutPressed() == .start)
        #expect(s.phase == .capturing)
        #expect(s.shortcutPressed() == .none) // still grabbing the frames
        s.captured()
        #expect(s.phase == .choosing)
        #expect(s.shortcutPressed() == .dismiss)
        #expect(!s.isActive)
    }

    @Test func escapeDuringTheGrabMeansTheOverlayNeverShows() {
        var s = ScreenshotSession()
        _ = s.shortcutPressed()
        let ended = s.end()
        #expect(ended)
        s.captured()
        #expect(s.phase == .idle)
        let endedAgain = s.end()
        #expect(!endedAgain)
    }
}

@Suite struct ScreenshotPreviewTimerTests {
    @Test func closesAfterSevenSeconds() {
        let t = ScreenshotPreviewTimer(shownAt: 100)
        #expect(t.closesAt == 107)
        #expect(!t.shouldClose(at: 106.9))
        #expect(t.shouldClose(at: 107))
    }

    @Test func hoveringPausesAndLeavingResumes() {
        var t = ScreenshotPreviewTimer(shownAt: 0)
        t.hover(true, at: 3)
        #expect(t.isPaused)
        #expect(t.closesAt == nil)
        #expect(!t.shouldClose(at: 60))
        t.hover(false, at: 60)
        #expect(t.closesAt == 64) // the 4 seconds left
    }

    @Test func leavingLateStillGivesTwoSeconds() {
        var t = ScreenshotPreviewTimer(shownAt: 0)
        t.hover(true, at: 6.5)
        t.hover(false, at: 10)
        #expect(t.closesAt == 12)
    }

    @Test func draggingOutKeepsItOnScreen() {
        var t = ScreenshotPreviewTimer(shownAt: 0)
        t.hover(true, at: 1)
        t.dragging(true, at: 2)
        t.hover(false, at: 3) // the drag left the panel
        #expect(t.isPaused)
        t.dragging(false, at: 30)
        #expect(t.closesAt == 36)
    }

    @Test func pinnedStaysUntilUnpinned() {
        var t = ScreenshotPreviewTimer(shownAt: 0)
        t.togglePin(at: 1)
        #expect(t.isPinned)
        #expect(t.closesAt == nil)
        #expect(!t.shouldClose(at: 1_000))
        t.togglePin(at: 1_000)
        #expect(t.closesAt == 1_006)
    }

    @Test func hoveringWhilePinnedDoesNotUseUpTheCountdown() {
        var t = ScreenshotPreviewTimer(shownAt: 0)
        t.togglePin(at: 1)
        t.hover(true, at: 500)
        t.hover(false, at: 501)
        t.togglePin(at: 600)
        #expect(t.closesAt == 606)
    }

    @Test func pinWhileHoveredThenUnpinWhileStillHovered() {
        var t = ScreenshotPreviewTimer(shownAt: 0)
        t.hover(true, at: 2)
        t.togglePin(at: 3)
        t.togglePin(at: 4)
        #expect(t.isPaused)
        t.hover(false, at: 5)
        #expect(t.closesAt == 10)
    }
}
