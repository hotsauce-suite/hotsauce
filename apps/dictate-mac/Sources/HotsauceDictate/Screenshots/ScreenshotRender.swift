import AppKit
import DictateCore
import SwiftUI

/// `HotsauceDictate --render-screenshot-overlay <folder>`: draws the capture overlay (idle, over a
/// window, dragging), the preview card and the Screen Recording window over a made-up screen to
/// PNGs, so they can be checked by eye without Screen Recording permission.
@MainActor
enum ScreenshotRender {
    static let screen = CGSize(width: 1440, height: 900)
    static let scale: CGFloat = 2
    static let display = CaptureDisplay(id: 1, frame: CGRect(origin: .zero, size: screen), pixelWidth: 2880, pixelHeight: 1800)
    static let back = CGRect(x: 120, y: 90, width: 760, height: 520)
    static let front = CGRect(x: 560, y: 300, width: 760, height: 470)
    static let windows = [
        CaptureWindow(id: 10, frame: CGRect(x: 0, y: 0, width: 1440, height: 24), layer: 24, ownerPID: 1, ownerName: "Window Server"),
        CaptureWindow(id: 11, frame: front, layer: 0, ownerPID: 2, ownerName: "Notes"),
        CaptureWindow(id: 12, frame: back, layer: 0, ownerPID: 3, ownerName: "Safari"),
    ]

    static func render(to folder: String) -> Int32 {
        let out = URL(fileURLWithPath: folder, isDirectory: true)
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        guard let frame = standInFrame() else { return fail("couldn’t draw the stand-in screen") }
        let frozen = FrozenDisplay(display: display, image: frame, screen: NSScreen.main ?? NSScreen())
        let states: [(String, CGPoint, CGPoint?)] = [
            ("screenshot-overlay-idle", CGPoint(x: 1360, y: 820), nil),
            ("screenshot-overlay-window", CGPoint(x: 900, y: 520), nil),
            ("screenshot-overlay-dragging", CGPoint(x: 700, y: 430), CGPoint(x: 260, y: 160)),
        ]
        for (name, pointer, start) in states {
            let marks = CaptureMarksView(frozen: frozen, windows: CaptureGeometry.pickableWindows(windows, ownPID: 999))
            marks.simulate(pointer: pointer, dragFrom: start)
            guard let image = draw(size: screen, { context in
                drawImage(frame, in: CGRect(origin: .zero, size: screen), context: context)
                marks.marks().draw(in: CGRect(origin: .zero, size: screen))
            }) else { return fail("couldn’t draw \(name)") }
            guard write(image, to: out.appendingPathComponent("\(name).png")) else { return fail("couldn’t save \(name)") }
        }

        // The preview of the dragged area, in light and dark, with the controls showing.
        guard let crop = ScreenshotImage.crop(frame, display: display, to: CaptureGeometry.dragRect(from: CGPoint(x: 260, y: 160), to: CGPoint(x: 700, y: 430))),
              let png = ScreenshotImage.png(crop)
        else { return fail("couldn’t crop") }
        let shot = Screenshot(image: crop, png: png, fileURL: nil, takenAt: Date())
        let shared = ScreenshotShare.message(.shared(url: URL(string: "https://example.com/s/x")!, anyone: true, deleteAfter: Date(timeIntervalSince1970: 1_797_724_800)))
        for (name, appearance, hovered) in [("screenshot-preview-light", NSAppearance.Name.aqua, true), ("screenshot-preview-dark", .darkAqua, true), ("screenshot-preview-resting", .aqua, false), ("screenshot-preview-sharing", .aqua, true), ("screenshot-preview-shared", .aqua, false), ("screenshot-preview-shared-dark", .darkAqua, false)] {
            let view = ScreenshotPreviewView(shot: shot)
            view.editEnabled = true
            view.hasShare = true
            view.sharing = name.hasSuffix("sharing")
            if name.contains("shared") { view.note = shared }
            view.showsControls = hovered
            view.appearance = NSAppearance(named: appearance)
            view.layoutSubtreeIfNeeded()
            guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return fail("couldn’t draw \(name)") }
            NSAppearance(named: appearance)?.performAsCurrentDrawingAppearance { view.cacheDisplay(in: view.bounds, to: rep) }
            guard let data = rep.representation(using: .png, properties: [:]) else { return fail("couldn’t save \(name)") }
            try? data.write(to: out.appendingPathComponent("\(name).png"))
        }

        // The Screen Recording window's content, each advice, drawn by its own hosting view in an
        // offscreen window.
        for (name, advice) in [("turn-on", ScreenRecordingCheck.Advice.turnOn), ("restart", .restart), ("remove-and-add-again", .removeAndAddAgain)] {
            let host = NSHostingView(rootView: ScreenRecordingPromptView(advice: advice, open: {}, relaunch: {}, close: {}))
            let window = NSWindow(contentRect: CGRect(origin: .zero, size: host.fittingSize), styleMask: [.titled], backing: .buffered, defer: false)
            window.appearance = NSAppearance(named: .aqua)
            window.contentView = host
            host.layoutSubtreeIfNeeded()
            if let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) {
                host.cacheDisplay(in: host.bounds, to: rep)
                try? rep.representation(using: .png, properties: [:])?.write(to: out.appendingPathComponent("screenshot-permission-\(name).png"))
            }
        }
        return 0
    }

    /// A made-up desktop: a warm wallpaper, a menu bar, two windows and a Dock.
    static func standInFrame() -> CGImage? {
        draw(size: screen) { context in
            let colors = [CGColor(srgbRed: 0.93, green: 0.6, blue: 0.27, alpha: 1), CGColor(srgbRed: 0.45, green: 0.16, blue: 0.09, alpha: 1)] as CFArray
            if let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: colors, locations: [0, 1]) {
                context.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: screen.width, y: screen.height), options: [])
            }
            context.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.55))
            context.fill(CGRect(x: 0, y: 0, width: screen.width, height: 24))
            standInWindow(back, dark: false, context: context)
            standInWindow(front, dark: true, context: context)
            context.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.35))
            context.addPath(CGPath(roundedRect: CGRect(x: 470, y: 830, width: 500, height: 60), cornerWidth: 18, cornerHeight: 18, transform: nil))
            context.fillPath()
        }
    }

    private static func standInWindow(_ rect: CGRect, dark: Bool, context: CGContext) {
        context.addPath(CGPath(roundedRect: rect, cornerWidth: 12, cornerHeight: 12, transform: nil))
        context.setFillColor(dark ? CGColor(srgbRed: 0.12, green: 0.11, blue: 0.11, alpha: 1) : CGColor(srgbRed: 0.98, green: 0.96, blue: 0.93, alpha: 1))
        context.fillPath()
        for (index, color) in [(1.0, 0.37, 0.34), (1.0, 0.74, 0.18), (0.16, 0.79, 0.25)].enumerated() {
            context.setFillColor(CGColor(srgbRed: color.0, green: color.1, blue: color.2, alpha: 1))
            context.fillEllipse(in: CGRect(x: rect.minX + 16 + CGFloat(index) * 20, y: rect.minY + 14, width: 12, height: 12))
        }
        context.setFillColor(dark ? CGColor(srgbRed: 0.85, green: 0.82, blue: 0.78, alpha: 0.35) : CGColor(srgbRed: 0.35, green: 0.3, blue: 0.27, alpha: 0.35))
        for row in 0..<9 {
            let width = [520, 440, 600, 260, 0, 560, 480, 320, 540][row]
            context.fill(CGRect(x: rect.minX + 40, y: rect.minY + 70 + CGFloat(row) * 34, width: CGFloat(width) * rect.width / 760, height: 10))
        }
    }

    /// A Retina bitmap with the origin at the top-left, as the overlay draws, and an AppKit
    /// context around it for text.
    private static func draw(size: CGSize, _ body: (CGContext) -> Void) -> CGImage? {
        guard let context = CGContext(
            data: nil, width: Int(size.width * scale), height: Int(size.height * scale), bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.translateBy(x: 0, y: size.height * scale)
        context.scaleBy(x: scale, y: -scale)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: true)
        body(context)
        NSGraphicsContext.restoreGraphicsState()
        return context.makeImage()
    }

    /// A CGImage the right way up in a top-left context.
    private static func drawImage(_ image: CGImage, in rect: CGRect, context: CGContext) {
        context.saveGState()
        context.translateBy(x: rect.minX, y: rect.maxY)
        context.scaleBy(x: 1, y: -1)
        context.draw(image, in: CGRect(origin: .zero, size: rect.size))
        context.restoreGState()
    }

    private static func write(_ image: CGImage, to url: URL) -> Bool {
        guard let data = ScreenshotImage.png(image) else { return false }
        return (try? data.write(to: url)) != nil
    }

    private static func fail(_ message: String) -> Int32 {
        FileHandle.standardError.write(Data("hotsauce-dictate: \(message)\n".utf8))
        return 1
    }
}
