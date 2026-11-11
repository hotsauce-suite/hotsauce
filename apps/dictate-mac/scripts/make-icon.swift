// Draws Resources/AppIcon.icns: an ember-orange tile with a microphone, in Hearth's palette.
// Run once from apps/dictate-mac: `swift scripts/make-icon.swift && iconutil -c icns build/AppIcon.iconset -o Resources/AppIcon.icns`
import AppKit

let sizes: [(String, CGFloat)] = [
    ("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64), ("128x128", 128),
    ("128x128@2x", 256), ("256x256", 256), ("256x256@2x", 512), ("512x512", 512), ("512x512@2x", 1024),
]
let dir = URL(fileURLWithPath: "build/AppIcon.iconset")
try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

for (name, size) in sizes {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = size / 1024
    let tile = NSBezierPath(roundedRect: NSRect(x: 100 * s, y: 100 * s, width: 824 * s, height: 824 * s), xRadius: 185 * s, yRadius: 185 * s)
    NSGradient(colors: [NSColor(red: 0.93, green: 0.42, blue: 0.2, alpha: 1), NSColor(red: 0.66, green: 0.19, blue: 0.06, alpha: 1)])!.draw(in: tile, angle: -90)
    NSColor(red: 1, green: 0.96, blue: 0.9, alpha: 1).setFill()
    NSColor(red: 1, green: 0.96, blue: 0.9, alpha: 1).setStroke()
    NSBezierPath(roundedRect: NSRect(x: 412 * s, y: 430 * s, width: 200 * s, height: 330 * s), xRadius: 100 * s, yRadius: 100 * s).fill()
    let arc = NSBezierPath()
    arc.lineWidth = 46 * s
    arc.lineCapStyle = .round
    arc.appendArc(withCenter: NSPoint(x: 512 * s, y: 540 * s), radius: 175 * s, startAngle: 200, endAngle: 340, clockwise: false)
    arc.stroke()
    let stem = NSBezierPath()
    stem.lineWidth = 46 * s
    stem.lineCapStyle = .round
    stem.move(to: NSPoint(x: 512 * s, y: 365 * s))
    stem.line(to: NSPoint(x: 512 * s, y: 285 * s))
    stem.move(to: NSPoint(x: 422 * s, y: 285 * s))
    stem.line(to: NSPoint(x: 602 * s, y: 285 * s))
    stem.stroke()
    NSGraphicsContext.restoreGraphicsState()
    try rep.representation(using: .png, properties: [:])!.write(to: dir.appendingPathComponent("icon_\(name).png"))
}
