import CoreGraphics
import CoreText
import Foundation

/// The capture's pixels, read once, for the redaction mosaic's averages.
public final class ShotPixels: @unchecked Sendable {
    public let width: Int
    public let height: Int
    /// RGBA, premultiplied, row 0 at the top.
    let bytes: [UInt8]

    public init?(image: CGImage) {
        let width = image.width
        let height = image.height
        self.width = width
        self.height = height
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return nil }
        self.bytes = bytes
    }

    /// Averages already worked out, so a mosaic doesn't redo them on every redraw.
    private struct Cell: Hashable { let x, y, width, height: Int }
    private var averages: [Cell: ShotColor] = [:]

    /// The average colour of a whole-pixel rectangle (clamped to the image).
    func average(_ rect: CGRect) -> ShotColor {
        let key = Cell(x: Int(rect.minX), y: Int(rect.minY), width: Int(rect.width), height: Int(rect.height))
        if let known = averages[key] { return known }
        let color = computeAverage(rect)
        if averages.count > 20_000 { averages.removeAll() }
        averages[key] = color
        return color
    }

    private func computeAverage(_ rect: CGRect) -> ShotColor {
        let r = rect.intersection(CGRect(x: 0, y: 0, width: width, height: height))
        guard !r.isNull, r.width >= 1, r.height >= 1 else { return ShotColor(red: 0, green: 0, blue: 0) }
        var sum = (0.0, 0.0, 0.0)
        var count = 0.0
        for y in Int(r.minY)..<Int(r.maxY) {
            var index = (y * width + Int(r.minX)) * 4
            for _ in Int(r.minX)..<Int(r.maxX) {
                sum.0 += Double(bytes[index]); sum.1 += Double(bytes[index + 1]); sum.2 += Double(bytes[index + 2])
                index += 4
                count += 1
            }
        }
        return ShotColor(red: sum.0 / count / 255, green: sum.1 / count / 255, blue: sum.2 / count / 255)
    }
}

/// Draws a document: one renderer for the editor view (at any zoom), the export (1:1) and the
/// self-test, so what is seen is what is exported (docs/PLAN-screenshots.md R11, R12).
public enum ShotRenderer {
    /// Mosaic blocks are at least this many pixels, and at least a quarter of the region's shorter
    /// side (a line of text is then three or four blocks tall), so text under them can't be read
    /// back, nor the shapes of its words.
    public static let mosaicMinimumBlock: CGFloat = 16

    public static func mosaicBlock(for rect: CGRect) -> CGFloat {
        max(mosaicMinimumBlock, ceil(min(rect.width, rect.height) / 4))
    }

    /// Draws the capture and its layers. The context's coordinates must already be SOURCE PIXELS,
    /// origin top-left, y down (see `export` for how). `pixels` feeds the mosaic.
    public static func draw(_ document: ShotDocument, source: CGImage, pixels: ShotPixels?, in context: CGContext, skipping: Set<Int> = []) {
        context.saveGState()
        context.interpolationQuality = .high
        // CGImage draws bottom-up; flip it locally.
        context.saveGState()
        context.translateBy(x: 0, y: CGFloat(document.sourceHeight))
        context.scaleBy(x: 1, y: -1)
        context.draw(source, in: document.sourceBounds)
        context.restoreGState()
        for layer in document.layers where !skipping.contains(layer.id) {
            draw(layer, pixels: pixels, in: context)
        }
        context.restoreGState()
    }

    public static func draw(_ layer: ShotLayer, pixels: ShotPixels?, in context: CGContext) {
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
        case let .redact(r, style):
            drawRedaction(ShotGeometry.integral(r), style: style, color: layer.color, pixels: pixels, in: context)
        }
    }

    /// Opaque, with no antialiasing, over whole pixels: nothing of what was under it survives.
    static func drawRedaction(_ rect: CGRect, style: RedactStyle, color: ShotColor, pixels: ShotPixels?, in context: CGContext) {
        context.setShouldAntialias(false)
        context.setBlendMode(.copy)
        guard style == .mosaic, let pixels else {
            context.setFillColor(color.with(alpha: 1).cgColor)
            context.fill(rect)
            return
        }
        for cell in mosaicCells(rect) {
            context.setFillColor(pixels.average(cell).cgColor)
            context.fill(cell)
        }
    }

    /// The mosaic's cells: whole blocks across the region, with a thin leftover row or column
    /// folded into its neighbour, so no cell is a sliver of a few raw pixels.
    public static func mosaicCells(_ rect: CGRect) -> [CGRect] {
        let block = mosaicBlock(for: rect)
        func edges(_ start: CGFloat, _ end: CGFloat) -> [CGFloat] {
            var cuts: [CGFloat] = [start]
            var position = start + block
            while position < end { cuts.append(position); position += block }
            if cuts.count > 1, end - cuts[cuts.count - 1] < block / 2 { cuts.removeLast() }
            return cuts + [end]
        }
        let xs = edges(rect.minX, rect.maxX), ys = edges(rect.minY, rect.maxY)
        var cells: [CGRect] = []
        for (y0, y1) in zip(ys, ys.dropFirst()) {
            for (x0, x1) in zip(xs, xs.dropFirst()) { cells.append(CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)) }
        }
        return cells
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
    public static func export(_ document: ShotDocument, source: CGImage, pixels: ShotPixels? = nil) -> CGImage? {
        let visible = document.visibleRect
        guard let context = CGContext(
            data: nil, width: Int(visible.width), height: Int(visible.height), bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.translateBy(x: 0, y: visible.height)
        context.scaleBy(x: 1, y: -1)
        context.translateBy(x: -visible.minX, y: -visible.minY)
        let needsPixels = document.layers.contains { if case .redact(_, .mosaic) = $0.shape { true } else { false } }
        draw(document, source: source, pixels: pixels ?? (needsPixels ? ShotPixels(image: source) : nil), in: context)
        return context.makeImage()
    }

    /// The export as PNG with no metadata (no thumbnail, nothing of the original).
    public static func exportPNG(_ document: ShotDocument, source: CGImage, pixels: ShotPixels? = nil) -> Data? {
        export(document, source: source, pixels: pixels).flatMap(ScreenshotImage.png)
    }
}
