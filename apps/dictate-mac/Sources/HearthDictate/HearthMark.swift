import AppKit
import DictateCore

/// The Hearth mark, an arch over a flame: the web app's favicon (apps/web/public/favicon.svg),
/// drawn here so the app icon and the menu bar icon are the same drawing.
enum HearthMark {
    /// The mark's two shapes, from the favicon's 64×64 space (y down) into `rect` (y up).
    static func paths(in rect: NSRect) -> (arch: NSBezierPath, flame: NSBezierPath, archWidth: CGFloat) {
        let k = rect.width / 64
        func p(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x: rect.minX + x * k, y: rect.minY + (64 - y) * k) }

        // M15 55 V31 a17 17 0 0 1 34 0 v24
        let arch = NSBezierPath()
        arch.move(to: p(15, 55))
        arch.line(to: p(15, 31))
        arch.appendArc(withCenter: p(32, 31), radius: 17 * k, startAngle: 180, endAngle: 0, clockwise: true)
        arch.line(to: p(49, 55))
        arch.lineCapStyle = .round
        arch.lineJoinStyle = .round

        // M32 22 c5.6 6.3 8.8 10.6 8.8 15.6 a8.8 8.8 0 0 1 -17.6 0 c0 -3.3 1.6 -5.7 3.6 -8
        // .6 2.7 1.7 4.1 3.6 4.7 -.9 -4.4 0 -8.5 1.6 -12.3z
        let flame = NSBezierPath()
        flame.move(to: p(32, 22))
        flame.curve(to: p(40.8, 37.6), controlPoint1: p(37.6, 28.3), controlPoint2: p(40.8, 32.6))
        flame.appendArc(withCenter: p(32, 37.6), radius: 8.8 * k, startAngle: 0, endAngle: 180, clockwise: true)
        flame.curve(to: p(26.8, 29.6), controlPoint1: p(23.2, 34.3), controlPoint2: p(24.8, 31.9))
        flame.curve(to: p(30.4, 34.3), controlPoint1: p(27.4, 32.3), controlPoint2: p(28.5, 33.7))
        flame.curve(to: p(32, 22), controlPoint1: p(29.5, 29.9), controlPoint2: p(30.4, 25.8))
        flame.close()
        return (arch, flame, 4.5 * k)
    }

    /// The menu bar icon: the mark alone, black on clear, as a template image so macOS colours it
    /// for the menu bar (and the status button can tint it while listening).
    static func menuBarImage() -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size, flipped: false) { bounds in
            // The mark's ink spans about 39×45 of its 64 units, centred on (32, 35): scaled so it
            // stands about 16 pt tall in the 18 pt square, centred on the ink, not the canvas.
            let k = bounds.height * 0.9 / 45
            let rect = NSRect(x: bounds.midX - 32 * k, y: bounds.midY - 29 * k, width: 64 * k, height: 64 * k)
            let (arch, flame, width) = paths(in: rect)
            NSColor.black.set()
            arch.lineWidth = max(1.5, width)
            arch.stroke()
            flame.fill()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = Brand.name
        return image
    }

    /// The app icon at `pixels` square: macOS's rounded tile (824 of 1024, inset 100) in the
    /// favicon's warm paper, the ink arch and the ember flame.
    static func appIcon(pixels: Int) -> NSBitmapImageRep {
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8,
                                   samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                   bytesPerRow: 0, bitsPerPixel: 0)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        let s = CGFloat(pixels) / 1024
        let tileRect = NSRect(x: 100 * s, y: 100 * s, width: 824 * s, height: 824 * s)
        let tile = NSBezierPath(roundedRect: tileRect, xRadius: 185 * s, yRadius: 185 * s)
        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.28)
        shadow.shadowOffset = NSSize(width: 0, height: -10 * s)
        shadow.shadowBlurRadius = 24 * s
        shadow.set()
        NSColor(srgbHex: 0xF2EADF).setFill()
        tile.fill()
        NSGraphicsContext.restoreGraphicsState()
        // The favicon's warm glow from below.
        NSGradient(colorsAndLocations: (NSColor(srgbHex: 0xF6C48A), 0), (NSColor(srgbHex: 0xF2EADF), 0.55))!
            .draw(in: tile, relativeCenterPosition: NSPoint(x: 0, y: -0.84))
        let (arch, flame, width) = paths(in: tileRect)
        NSColor(srgbHex: 0x2A221D).setStroke()
        arch.lineWidth = width
        arch.stroke()
        NSColor(srgbHex: Brand.accentLight).setFill()
        flame.fill()
        NSGraphicsContext.restoreGraphicsState()
        return rep
    }

    /// `HearthDictate --render-app-icon <folder>`: the iconset for Resources/AppIcon.icns
    /// (`iconutil -c icns <folder> -o Resources/AppIcon.icns`).
    static func renderIconset(to folder: String) -> Int32 {
        let dir = URL(fileURLWithPath: folder)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let sizes: [(String, Int)] = [
            ("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64), ("128x128", 128),
            ("128x128@2x", 256), ("256x256", 256), ("256x256@2x", 512), ("512x512", 512), ("512x512@2x", 1024),
        ]
        for (name, pixels) in sizes {
            guard let png = appIcon(pixels: pixels).representation(using: .png, properties: [:]) else { return 1 }
            do { try png.write(to: dir.appendingPathComponent("icon_\(name).png")) } catch { return 1 }
        }
        // The menu bar icon too, for checking it by eye.
        let bar = menuBarImage()
        for (name, scale) in [("menubar.png", 1.0), ("menubar@2x.png", 2.0), ("menubar@4x.png", 4.0)] {
            let px = Int(18 * scale)
            let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                                       hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
            bar.draw(in: NSRect(x: 0, y: 0, width: px, height: px))
            NSGraphicsContext.restoreGraphicsState()
            try? rep.representation(using: .png, properties: [:])?.write(to: dir.deletingLastPathComponent().appendingPathComponent(name))
        }
        return 0
    }
}

private extension NSColor {
    convenience init(srgbHex hex: UInt32) {
        self.init(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}
