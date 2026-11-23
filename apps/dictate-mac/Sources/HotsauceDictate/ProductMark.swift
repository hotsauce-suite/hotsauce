import AppKit
import DictateCore

/// The Hotsauce bottle: the web app's favicon (apps/web/public/favicon.svg, the same drawing as
/// hotsauce.work), drawn here so the app icon and the menu bar icon are the same drawing.
enum ProductMark {
    struct Shapes {
        let cap: NSBezierPath
        let bottle: NSBezierPath
        let label: NSBezierPath
        let flame: NSBezierPath
        /// The glint of light on the glass's left shoulder: a stroke, not a fill.
        let glint: NSBezierPath
        /// The favicon's 2.75 unit outline, in `rect`'s points.
        let outline: CGFloat
    }

    /// The mark's five shapes, from the favicon's 64×64 space (y down) into `rect` (y up).
    static func shapes(in rect: NSRect) -> Shapes {
        let k = rect.width / 64
        func p(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x: rect.minX + x * k, y: rect.minY + (64 - y) * k) }
        func box(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ r: CGFloat) -> NSBezierPath {
            NSBezierPath(roundedRect: NSRect(x: rect.minX + x * k, y: rect.minY + (64 - y - h) * k, width: w * k, height: h * k),
                         xRadius: r * k, yRadius: r * k)
        }

        // <rect x="23.5" y="3" width="17" height="10" rx="3"/>
        let cap = box(23.5, 3, 17, 10, 3)

        // M27 13 h10 v7 c0 3 11 6 11 16 v18 a7 7 0 0 1 -7 7 H23 a7 7 0 0 1 -7 -7 V36 c0 -10 11 -13 11 -16 z
        let bottle = NSBezierPath()
        bottle.move(to: p(27, 13))
        bottle.line(to: p(37, 13))
        bottle.line(to: p(37, 20))
        bottle.curve(to: p(48, 36), controlPoint1: p(37, 23), controlPoint2: p(48, 26))
        bottle.line(to: p(48, 54))
        bottle.appendArc(withCenter: p(41, 54), radius: 7 * k, startAngle: 0, endAngle: -90, clockwise: true)
        bottle.line(to: p(23, 61))
        bottle.appendArc(withCenter: p(23, 54), radius: 7 * k, startAngle: -90, endAngle: -180, clockwise: true)
        bottle.line(to: p(16, 36))
        bottle.curve(to: p(27, 20), controlPoint1: p(16, 26), controlPoint2: p(27, 23))
        bottle.close()
        bottle.lineJoinStyle = .round

        // <rect x="18.5" y="33" width="27" height="19.5" rx="4"/>
        let label = box(18.5, 33, 27, 19.5, 4)

        // M34.02 35.1 C37.27 38.34 38.89 40.64 38.89 43.34 A6.885 6.885 0 0 1 25.11 43.34
        // C25.11 41.45 26.06 39.96 27.27 38.61 C27.68 40.23 28.36 41.04 29.44 41.31
        // C29.44 39.15 30.65 36.86 34.02 35.1z
        let flame = NSBezierPath()
        flame.move(to: p(34.02, 35.1))
        flame.curve(to: p(38.89, 43.34), controlPoint1: p(37.27, 38.34), controlPoint2: p(38.89, 40.64))
        flame.appendArc(withCenter: p(32, 43.34), radius: 6.885 * k, startAngle: 0, endAngle: 180, clockwise: true)
        flame.curve(to: p(27.27, 38.61), controlPoint1: p(25.11, 41.45), controlPoint2: p(26.06, 39.96))
        flame.curve(to: p(29.44, 41.31), controlPoint1: p(27.68, 40.23), controlPoint2: p(28.36, 41.04))
        flame.curve(to: p(34.02, 35.1), controlPoint1: p(29.44, 39.15), controlPoint2: p(30.65, 36.86))
        flame.close()

        // M21.5 31.5 C22.7 29.1 24.7 27.3 26.8 25.9, stroked 2.4 wide with round caps
        let glint = NSBezierPath()
        glint.move(to: p(21.5, 31.5))
        glint.curve(to: p(26.8, 25.9), controlPoint1: p(22.7, 29.1), controlPoint2: p(24.7, 27.3))
        glint.lineWidth = 2.4 * k
        glint.lineCapStyle = .round
        return Shapes(cap: cap, bottle: bottle, label: label, flame: flame, glint: glint, outline: 2.75 * k)
    }

    /// The menu bar icon: the bottle's silhouette, black on clear with the label cut out and the
    /// flame on it, as a template image so macOS colours it for the menu bar (and the status
    /// button can tint it while listening).
    static func menuBarImage() -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size, flipped: false) { bounds in
            // The bottle's ink spans 32×58 of its 64 units, centred on (32, 32): scaled so it
            // stands 16 pt tall in the 18 pt square.
            let k = bounds.height * (16.0 / 18.0) / 58
            let rect = NSRect(x: bounds.midX - 32 * k, y: bounds.midY - 32 * k, width: 64 * k, height: 64 * k)
            let m = shapes(in: rect)
            NSColor.black.setFill()
            m.cap.fill()
            m.bottle.fill()
            // A gap between cap and neck, so the two read as separate pieces.
            let context = NSGraphicsContext.current
            context?.compositingOperation = .clear
            NSRect(x: rect.minX + 26 * k, y: rect.minY + (64 - 13.6) * k, width: 12 * k, height: 1.2 * k).fill()
            // The old, smaller label box: the tuned label would leave walls under a pixel wide at 18 pt.
            NSBezierPath(roundedRect: NSRect(x: rect.minX + 20 * k, y: rect.minY + (64 - 34 - 17) * k, width: 24 * k, height: 17 * k),
                         xRadius: 3 * k, yRadius: 3 * k).fill()
            context?.compositingOperation = .sourceOver
            m.flame.fill()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = Brand.name
        return image
    }

    /// The app icon at `pixels` square: macOS's rounded tile (824 of 1024, inset 100) in
    /// hotsauce.work's dark ink with a rust glow from below, and the bottle on it at 90% of the
    /// tile. Matches `apps/web/scripts/render-icons.mjs --mac`, which rendered Resources/AppIcon.icns.
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
        NSColor(srgbHex: 0x16262D).setFill()
        tile.fill()
        NSGraphicsContext.restoreGraphicsState()
        NSGradient(colorsAndLocations: (NSColor(srgbHex: 0xA94E26).withAlphaComponent(0.55), 0),
                   (NSColor(srgbHex: 0x16262D).withAlphaComponent(0), 0.8))!
            .draw(in: tile, relativeCenterPosition: NSPoint(x: 0, y: -0.7))
        // The bottle spans 58 of its 64 units (about 61 with its outline): drawn at 90% of the tile it fills
        // most of the tile's height, centred. Its outline is darker than the tile so it still shows.
        let side = tileRect.width * 0.9
        let m = shapes(in: NSRect(x: tileRect.midX - side / 2, y: tileRect.midY - side / 2, width: side, height: side))
        NSColor(srgbHex: 0x0B1418).setStroke()
        for (shape, fill, width) in [(m.cap, 0x1F4D3A, m.outline), (m.bottle, 0xA94E26, m.outline),
                                     (m.label, 0xFFF4E2, m.outline * 2.25 / 2.75)] as [(NSBezierPath, UInt32, CGFloat)] {
            NSColor(srgbHex: fill).setFill()
            shape.fill()
            shape.lineWidth = width
            shape.stroke()
            if shape === m.bottle {
                NSColor(srgbHex: 0xFFF4E2).withAlphaComponent(0.85).setStroke()
                m.glint.stroke()
                NSColor(srgbHex: 0x0B1418).setStroke()
            }
        }
        NSColor(srgbHex: 0xA94E26).setFill()
        m.flame.fill()
        NSGraphicsContext.restoreGraphicsState()
        return rep
    }

    /// `Hotsauce --render-app-icon <folder>`: the iconset for Resources/AppIcon.icns
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
