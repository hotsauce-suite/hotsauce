import AppKit
import DictateCore
import ScreenCaptureKit

/// One display's frame, grabbed before the overlay showed (docs/PLAN-screenshots.md R8).
struct FrozenDisplay {
    let display: CaptureDisplay
    let image: CGImage
    let screen: NSScreen
}

/// Every display's frame and the windows that were on screen at that moment, front to back.
struct FrozenScreens {
    let displays: [FrozenDisplay]
    let windows: [CaptureWindow]
}

enum ScreenCapture {
    enum Failure: Error {
        /// macOS refused: Screen Recording is off for the app.
        case notAllowed
        case nothingCaptured
    }

    /// Grabs each display at its native pixel size with ScreenCaptureKit (needs Screen Recording),
    /// leaving out the given windows of ours (a preview still on screen).
    @MainActor
    static func grab(excluding windowNumbers: Set<Int>) async throws -> FrozenScreens {
        let windows = windowList()
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        } catch {
            throw Permissions.screenRecordingGranted ? error : Failure.notAllowed
        }
        let excluded = content.windows.filter { windowNumbers.contains(Int($0.windowID)) }
        var frozen: [FrozenDisplay] = []
        for display in content.displays {
            guard let screen = screen(for: display.displayID) else { continue }
            let bounds = CGDisplayBounds(display.displayID)
            let mode = CGDisplayCopyDisplayMode(display.displayID)
            let pixelWidth = mode?.pixelWidth ?? Int(bounds.width * screen.backingScaleFactor)
            let pixelHeight = mode?.pixelHeight ?? Int(bounds.height * screen.backingScaleFactor)
            let configuration = SCStreamConfiguration()
            configuration.width = pixelWidth
            configuration.height = pixelHeight
            configuration.showsCursor = false
            configuration.captureResolution = .best
            let filter = SCContentFilter(display: display, excludingWindows: excluded)
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
            // The frame's own size is the truth for the crop.
            let captured = CaptureDisplay(id: display.displayID, frame: bounds, pixelWidth: image.width, pixelHeight: image.height)
            frozen.append(FrozenDisplay(display: captured, image: image, screen: screen))
        }
        guard !frozen.isEmpty else { throw Failure.nothingCaptured }
        return FrozenScreens(displays: frozen, windows: windows)
    }

    static func screen(for displayID: CGDirectDisplayID) -> NSScreen? {
        NSScreen.screens.first {
            ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == displayID
        }
    }

    /// The on-screen windows, front to back, in global top-left points. CGWindowList documents
    /// that order (ScreenCaptureKit's list doesn't promise one), and frames and owners need no
    /// permission.
    static func windowList() -> [CaptureWindow] {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
        else { return [] }
        return list.compactMap { info in
            guard let number = info[kCGWindowNumber as String] as? NSNumber,
                  let bounds = info[kCGWindowBounds as String] as? NSDictionary,
                  let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary)
            else { return nil }
            return CaptureWindow(
                id: number.uint32Value,
                frame: frame,
                layer: (info[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
                ownerPID: (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0,
                ownerName: info[kCGWindowOwnerName as String] as? String,
                alpha: (info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
            )
        }
    }
}
