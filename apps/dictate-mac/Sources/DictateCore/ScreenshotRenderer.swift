import CoreGraphics
import CoreText
import Foundation

/// Draws a document: one renderer for the editor view (at any zoom), the export (1:1) and the
/// self-test, so what is seen is what is exported (docs/PLAN-screenshots.md R11, R12).
public enum ShotRenderer {
    /// Draws the capture and its layers. The context's coordinates must already be SOURCE PIXELS,
    /// origin top-left, y down (see `export` for how).
    public static func draw(_ document: ShotDocument, source: CGImage, in context: CGContext, skipping: Set<Int> = []) {
        context.saveGState()
        context.interpolationQuality = .high
        // CGImage draws bottom-up; flip it locally.
        context.saveGState()
        context.translateBy(x: 0, y: CGFloat(document.sourceHeight))
        context.scaleBy(x: 1, y: -1)
        context.draw(source, in: document.sourceBounds)
        context.restoreGState()
        for layer in document.layers where !skipping.contains(layer.id) {
            draw(layer, in: context)
        }
        context.restoreGState()
    }

    public static func draw(_ layer: ShotLayer, in context: CGContext) {
        context.saveGState()
        defer { context.restoreGState() }
        let color = layer.color.cgColor
        context.setLineCap(.round)
        context.setLineJoin(.round)
        switch layer.shape {
        case let .rectangle(r):
            context.setStrokeColor(color)
            context.setLineWidth(layer.width)
            context.stroke(r.standardized)
        case let .ellipse(r):
            context.setStrokeColor(color)
            context.setLineWidth(layer.width)
            context.strokeEllipse(in: r.standardized)
        case let .arrow(from, to):
            drawArrow(from: from, to: to, width: layer.width, color: color, in: context)
        case let .highlighter(points):
            guard let first = points.first else { return }
            context.setBlendMode(.multiply)
            context.setStrokeColor(layer.color.with(alpha: 0.45).cgColor)
            context.setLineWidth(layer.highlighterWidth)
            context.setLineCap(points.count == 2 ? .butt : .round)
            context.move(to: first)
            if points.count == 1 { context.addLine(to: first) }
            for point in points.dropFirst() { context.addLine(to: point) }
            context.strokePath()
        case let .text(origin, string, size):
            drawText(string, at: origin, size: size, color: color, in: context)
        case let .step(center, radius, number):
            let circle = CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)
            context.setFillColor(color)
            context.fillEllipse(in: circle)
            context.setStrokeColor(CGColor(gray: 1, alpha: 0.9))
            context.setLineWidth(max(1.5, radius * 0.1))
            context.strokeEllipse(in: circle.insetBy(dx: radius * 0.05, dy: radius * 0.05))
            let ink = layer.color.isLight ? ShotPalette.colors[5].color.cgColor : CGColor(gray: 1, alpha: 1)
            let label = "\(number)"
            let fontSize = radius * (label.count > 1 ? 0.95 : 1.15)
            let font = ShotText.font(size: fontSize)
            let line = CTLineCreateWithAttributedString(NSAttributedString(string: label, attributes: [
                kCTFontAttributeName as NSAttributedString.Key: font,
                kCTForegroundColorAttributeName as NSAttributedString.Key: ink,
            ]))
            let bounds = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
            context.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
            context.textPosition = CGPoint(x: center.x - bounds.midX, y: center.y + bounds.midY)
            CTLineDraw(line, context)
        case let .redact(r):
            drawRedaction(ShotGeometry.integral(r), color: layer.color, in: context)
        }
    }

    /// Opaque, with no antialiasing, over whole pixels: nothing of what was under it survives.
    /// (A pixelated mode was tried and removed: averages of hidden pixels on a grid aligned to the
    /// region can be matched against known fonts, so only a solid block is offered.)
    static func drawRedaction(_ rect: CGRect, color: ShotColor, in context: CGContext) {
        context.setShouldAntialias(false)
        context.setBlendMode(.copy)
        context.setFillColor(color.with(alpha: 1).cgColor)
        context.fill(rect)
    }

    /// Head length and half-width grow with the stroke, so a thick arrow keeps its shape.
    public static func arrowHead(width: CGFloat) -> (length: CGFloat, halfWidth: CGFloat) {
        (max(14, width * 4.5), max(8, width * 2.6))
    }

    static func drawArrow(from: CGPoint, to: CGPoint, width: CGFloat, color: CGColor, in context: CGContext) {
        let dx = to.x - from.x, dy = to.y - from.y
        let length = hypot(dx, dy)
        guard length > 0 else { return }
        let ux = dx / length, uy = dy / length
        let head = arrowHead(width: width)
        let headLength = min(head.length, length * 0.6)
        let halfWidth = head.halfWidth * headLength / head.length
        let base = CGPoint(x: to.x - ux * headLength, y: to.y - uy * headLength)
        context.setStrokeColor(color)
        context.setLineWidth(width)
        context.move(to: from)
        // The shaft stops inside the head, so its round cap doesn't poke out of the tip.
        context.addLine(to: CGPoint(x: base.x + ux * headLength * 0.3, y: base.y + uy * headLength * 0.3))
        context.strokePath()
        context.setFillColor(color)
        context.move(to: to)
        context.addLine(to: CGPoint(x: base.x - uy * halfWidth, y: base.y + ux * halfWidth))
        context.addLine(to: CGPoint(x: base.x + uy * halfWidth, y: base.y - ux * halfWidth))
        context.closePath()
        context.fillPath()
    }

    static func drawText(_ string: String, at origin: CGPoint, size: CGFloat, color: CGColor, in context: CGContext) {
        let font = ShotText.font(size: size)
        let lineHeight = ShotText.lineHeight(fontSize: size)
        let ascent = CTFontGetAscent(font)
        context.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
        for (index, text) in ShotText.lines(string).enumerated() where !text.isEmpty {
            let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [
                kCTFontAttributeName as NSAttributedString.Key: font,
                kCTForegroundColorAttributeName as NSAttributedString.Key: color,
            ]))
            context.textPosition = CGPoint(x: origin.x, y: origin.y + ascent + CGFloat(index) * lineHeight)
            CTLineDraw(line, context)
        }
    }

    /// The flattened picture at source pixel size, cropped: what is copied, saved and shared.
    public static func export(_ document: ShotDocument, source: CGImage) -> CGImage? {
        let visible = document.visibleRect
        guard let context = CGContext(
            data: nil, width: Int(visible.width), height: Int(visible.height), bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.translateBy(x: 0, y: visible.height)
        context.scaleBy(x: 1, y: -1)
        context.translateBy(x: -visible.minX, y: -visible.minY)
        draw(document, source: source, in: context)
        return context.makeImage()
    }

    /// The export as PNG with no metadata (no thumbnail, nothing of the original).
    public static func exportPNG(_ document: ShotDocument, source: CGImage) -> Data? {
        export(document, source: source).flatMap(ScreenshotImage.png)
    }
}
