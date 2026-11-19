import CoreGraphics
import CoreText
import Foundation

// The screenshot editor's document (docs/PLAN-screenshots.md R11): the untouched capture, an
// optional crop, and vector layers over it. Every coordinate is in SOURCE PIXELS of the capture,
// origin top-left, y down. Pure: the editor view and the exporter both read it, and it is tested.

/// A colour for annotations, in sRGB.
public struct ShotColor: Codable, Equatable, Hashable, Sendable {
    public var red, green, blue, alpha: Double

    public init(red: Double, green: Double, blue: Double, alpha: Double = 1) {
        self.red = red
        self.green = green
        self.blue = blue
        self.alpha = alpha
    }

    public init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }

    public var cgColor: CGColor {
        CGColor(srgbRed: red, green: green, blue: blue, alpha: alpha)
    }

    public func with(alpha: Double) -> ShotColor { ShotColor(red: red, green: green, blue: blue, alpha: alpha) }

    /// Light colours (yellow, white) take dark numbers and text on top.
    public var isLight: Bool { 0.299 * red + 0.587 * green + 0.114 * blue > 0.6 }
}

/// The editor's fixed palette and stroke widths.
public enum ShotPalette {
    /// Ember is the theme's night ember (Theme.swift), bright enough over any screenshot; ink is
    /// the theme's night paper.
    public static let colors: [(name: String, color: ShotColor)] = [
        ("Ember", ShotColor(hex: 0xFF6A3D)),
        ("Red", ShotColor(hex: 0xFF3B30)),
        ("Yellow", ShotColor(hex: 0xFFCC00)),
        ("Green", ShotColor(hex: 0x34C759)),
        ("Blue", ShotColor(hex: 0x0A84FF)),
        ("Black", ShotColor(hex: 0x1D1815)),
        ("White", ShotColor(hex: 0xFFFFFF)),
    ]
    public static let defaultColor = colors[0].color
    /// Thin, medium, thick, in source pixels (a Retina capture has two a point).
    public static let widths: [CGFloat] = [3, 6, 10]
    public static let defaultWidth: CGFloat = 6
    /// Redactions are opaque black unless another colour is picked.
    public static let redactColor = colors[5].color
}

/// The tools, with the key that picks each.
public enum ShotTool: String, CaseIterable, Codable, Sendable {
    case select, arrow, rectangle, ellipse, text, highlighter, step, redact, crop

    public var key: Character {
        switch self {
        case .select: "v"
        case .arrow: "a"
        case .rectangle: "r"
        case .ellipse: "o"
        case .text: "t"
        case .highlighter: "h"
        case .step: "n"
        case .redact: "x"
        case .crop: "c"
        }
    }

    public var title: String {
        switch self {
        case .select: "Select"
        case .arrow: "Arrow"
        case .rectangle: "Rectangle"
        case .ellipse: "Ellipse"
        case .text: "Text"
        case .highlighter: "Highlighter"
        case .step: "Numbered step"
        case .redact: "Redact"
        case .crop: "Crop"
        }
    }

    /// "Arrow (A)".
    public var tooltip: String { "\(title) (\(String(key).uppercased()))" }

    public static func forKey(_ key: Character) -> ShotTool? {
        allCases.first { $0.key == Character(key.lowercased()) }
    }
}

public enum RedactStyle: String, Codable, Sendable {
    /// An opaque block of colour.
    case fill
    /// Coarse blocks of the region's average colours.
    case mosaic
}

public enum ShotShape: Codable, Equatable, Sendable {
    case arrow(from: CGPoint, to: CGPoint)
    case rectangle(CGRect)
    case ellipse(CGRect)
    /// `origin` is the top-left of the text's box; the size is in source pixels.
    case text(origin: CGPoint, string: String, fontSize: CGFloat)
    case highlighter(points: [CGPoint])
    case step(center: CGPoint, radius: CGFloat, number: Int)
    case redact(CGRect, style: RedactStyle)
}

public struct ShotLayer: Codable, Equatable, Identifiable, Sendable {
    public var id: Int
    public var shape: ShotShape
    public var color: ShotColor
    /// Stroke width in source pixels.
    public var width: CGFloat

    public init(id: Int, shape: ShotShape, color: ShotColor, width: CGFloat) {
        self.id = id
        self.shape = shape
        self.color = color
        self.width = width
    }
}

public struct ShotDocument: Codable, Equatable, Sendable {
    public let sourceWidth: Int
    public let sourceHeight: Int
    /// Whole source pixels; nil shows the whole capture.
    public private(set) var crop: CGRect?
    /// Back to front.
    public private(set) var layers: [ShotLayer] = []
    private var nextID = 1

    public init(sourceWidth: Int, sourceHeight: Int) {
        self.sourceWidth = sourceWidth
        self.sourceHeight = sourceHeight
    }

    public var sourceBounds: CGRect { CGRect(x: 0, y: 0, width: sourceWidth, height: sourceHeight) }
    /// What is shown and exported.
    public var visibleRect: CGRect { crop ?? sourceBounds }
    /// Anything to save over the plain capture.
    public var isEdited: Bool { !layers.isEmpty || crop != nil }

    public func layer(_ id: Int) -> ShotLayer? { layers.first { $0.id == id } }
    public var allIDs: Set<Int> { Set(layers.map(\.id)) }

    @discardableResult
    public mutating func add(_ shape: ShotShape, color: ShotColor, width: CGFloat) -> Int {
        let id = nextID
        nextID += 1
        layers.append(ShotLayer(id: id, shape: shape, color: color, width: width))
        renumberSteps()
        return id
    }

    /// The number the next step would get.
    public var nextStepNumber: Int {
        layers.filter { if case .step = $0.shape { true } else { false } }.count + 1
    }

    public mutating func update(_ layer: ShotLayer) {
        guard let index = layers.firstIndex(where: { $0.id == layer.id }) else { return }
        layers[index] = layer
    }

    public mutating func delete(_ ids: Set<Int>) {
        layers.removeAll { ids.contains($0.id) }
        renumberSteps()
    }

    public mutating func move(_ ids: Set<Int>, by delta: CGVector) {
        for index in layers.indices where ids.contains(layers[index].id) {
            layers[index].shape = layers[index].shape.offset(by: delta)
        }
    }

    /// Arrow keys: one pixel, ten with Shift.
    public mutating func nudge(_ ids: Set<Int>, dx: Int, dy: Int, shift: Bool) {
        let step: CGFloat = shift ? 10 : 1
        move(ids, by: CGVector(dx: CGFloat(dx) * step, dy: CGFloat(dy) * step))
    }

    /// Copies of the layers, a little down and to the right, on top; returns the copies' ids.
    @discardableResult
    public mutating func duplicate(_ ids: Set<Int>, offset: CGFloat = 20) -> Set<Int> {
        var copies: Set<Int> = []
        for layer in layers where ids.contains(layer.id) {
            copies.insert(add(layer.shape.offset(by: CGVector(dx: offset, dy: offset)), color: layer.color, width: layer.width))
        }
        return copies
    }

    public mutating func setColor(_ ids: Set<Int>, _ color: ShotColor) {
        for index in layers.indices where ids.contains(layers[index].id) { layers[index].color = color }
    }

    public mutating func setWidth(_ ids: Set<Int>, _ width: CGFloat) {
        for index in layers.indices where ids.contains(layers[index].id) { layers[index].width = width }
    }

    /// Steps are numbered 1, 2, 3… in the order they sit, so deleting one closes the gap.
    public mutating func renumberSteps() {
        var number = 1
        for index in layers.indices {
            if case let .step(center, radius, _) = layers[index].shape {
                layers[index].shape = .step(center: center, radius: radius, number: number)
                number += 1
            }
        }
    }

    /// The same crop with only the redactions, as solid blocks: what Copy Text reads over the
    /// untouched capture, so text under a redaction is never read back out.
    public var redactionsOnly: ShotDocument {
        var copy = self
        copy.layers = layers.compactMap { layer in
            guard case let .redact(rect, _) = layer.shape else { return nil }
            var solid = layer
            solid.shape = .redact(rect, style: .fill)
            return solid
        }
        return copy
    }

    /// Whole pixels inside the capture; the whole capture (or nothing usable) clears it.
    public mutating func setCrop(_ rect: CGRect?) {
        guard let rect else { crop = nil; return }
        let whole = ShotGeometry.integral(rect).intersection(sourceBounds)
        if whole.isNull || whole.width < 1 || whole.height < 1 || whole == sourceBounds {
            crop = nil
        } else {
            crop = whole
        }
    }
}

extension ShotShape {
    public func offset(by d: CGVector) -> ShotShape {
        func p(_ point: CGPoint) -> CGPoint { CGPoint(x: point.x + d.dx, y: point.y + d.dy) }
        switch self {
        case let .arrow(from, to): return .arrow(from: p(from), to: p(to))
        case let .rectangle(r): return .rectangle(r.offsetBy(dx: d.dx, dy: d.dy))
        case let .ellipse(r): return .ellipse(r.offsetBy(dx: d.dx, dy: d.dy))
        case let .text(origin, string, size): return .text(origin: p(origin), string: string, fontSize: size)
        case let .highlighter(points): return .highlighter(points: points.map(p))
        case let .step(center, radius, number): return .step(center: p(center), radius: radius, number: number)
        case let .redact(r, style): return .redact(r.offsetBy(dx: d.dx, dy: d.dy), style: style)
        }
    }
}

/// Handles on a selected layer.
public enum ShotHandle: CaseIterable, Sendable {
    case topLeft, top, topRight, right, bottomRight, bottom, bottomLeft, left
    /// An arrow's two ends.
    case start, end

    static let corners: [ShotHandle] = [.topLeft, .topRight, .bottomRight, .bottomLeft]
    static let eight: [ShotHandle] = [.topLeft, .top, .topRight, .right, .bottomRight, .bottom, .bottomLeft, .left]

    public func position(in rect: CGRect) -> CGPoint {
        switch self {
        case .topLeft: CGPoint(x: rect.minX, y: rect.minY)
        case .top: CGPoint(x: rect.midX, y: rect.minY)
        case .topRight: CGPoint(x: rect.maxX, y: rect.minY)
        case .right: CGPoint(x: rect.maxX, y: rect.midY)
        case .bottomRight: CGPoint(x: rect.maxX, y: rect.maxY)
        case .bottom: CGPoint(x: rect.midX, y: rect.maxY)
        case .bottomLeft: CGPoint(x: rect.minX, y: rect.maxY)
        case .left: CGPoint(x: rect.minX, y: rect.midY)
        case .start, .end: CGPoint(x: rect.midX, y: rect.midY)
        }
    }
}

/// How a resize keeps its shape.
public enum ShotConstraint: Sendable {
    case free
    /// Shift on a rectangle, ellipse, redaction or crop: a square.
    case square
    /// Text and steps always scale evenly.
    case proportional
}

/// Text sizes, by CoreText, so hit testing and the renderer agree.
public enum ShotText {
    public static func font(size: CGFloat) -> CTFont {
        CTFontCreateUIFontForLanguage(.emphasizedSystem, size, nil) ?? CTFontCreateWithName("Helvetica-Bold" as CFString, size, nil)
    }

    public static func lines(_ string: String) -> [String] {
        string.components(separatedBy: "\n")
    }

    public static func lineHeight(fontSize: CGFloat) -> CGFloat {
        let font = font(size: fontSize)
        return ceil(CTFontGetAscent(font) + CTFontGetDescent(font) + CTFontGetLeading(font))
    }

    public static func size(_ string: String, fontSize: CGFloat) -> CGSize {
        let font = font(size: fontSize)
        var width: CGFloat = 0
        for line in lines(string) {
            let attributed = NSAttributedString(string: line, attributes: [kCTFontAttributeName as NSAttributedString.Key: font])
            width = max(width, CGFloat(CTLineGetTypographicBounds(CTLineCreateWithAttributedString(attributed), nil, nil, nil)))
        }
        // An empty line still has a caret's width, so new text can be clicked.
        return CGSize(width: max(ceil(width), fontSize * 0.5), height: lineHeight(fontSize: fontSize) * CGFloat(lines(string).count))
    }
}

extension ShotLayer {
    /// The box its handles sit on.
    public var bounds: CGRect {
        switch shape {
        case let .arrow(from, to): return ShotGeometry.rect(from, to)
        case let .rectangle(r), let .ellipse(r), let .redact(r, _): return r.standardized
        case let .text(origin, string, size): return CGRect(origin: origin, size: ShotText.size(string, fontSize: size))
        case let .highlighter(points):
            guard let first = points.first else { return .zero }
            return points.dropFirst().reduce(CGRect(origin: first, size: .zero)) { $0.union(CGRect(origin: $1, size: .zero)) }
        case let .step(center, radius, _): return CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)
        }
    }

    public var handles: [ShotHandle] {
        switch shape {
        case .arrow: [.start, .end]
        case .text, .step: ShotHandle.corners
        default: ShotHandle.eight
        }
    }

    public func handlePosition(_ handle: ShotHandle) -> CGPoint {
        if case let .arrow(from, to) = shape {
            if handle == .start { return from }
            if handle == .end { return to }
        }
        return handle.position(in: bounds)
    }

    /// The highlighter's painted width.
    public var highlighterWidth: CGFloat { max(14, width * 3) }

    /// Whether a point (source pixels) is on the layer, within `tolerance`.
    public func contains(_ point: CGPoint, tolerance: CGFloat) -> Bool {
        switch shape {
        case let .arrow(from, to):
            return ShotGeometry.distance(from: point, toSegment: from, to) <= width / 2 + tolerance + width * 1.5
        case let .highlighter(points):
            if points.count == 1 { return hypot(point.x - points[0].x, point.y - points[0].y) <= highlighterWidth / 2 + tolerance }
            return zip(points, points.dropFirst()).contains { ShotGeometry.distance(from: point, toSegment: $0, $1) <= highlighterWidth / 2 + tolerance }
        case let .step(center, radius, _):
            return hypot(point.x - center.x, point.y - center.y) <= radius + tolerance
        case let .ellipse(r):
            let box = r.standardized.insetBy(dx: -tolerance, dy: -tolerance)
            guard box.width > 0, box.height > 0 else { return false }
            let nx = (point.x - box.midX) / (box.width / 2)
            let ny = (point.y - box.midY) / (box.height / 2)
            return nx * nx + ny * ny <= 1
        case .rectangle, .redact, .text:
            return bounds.insetBy(dx: -tolerance, dy: -tolerance).contains(point)
        }
    }

    /// The layer with a handle dragged to `point`.
    public func resized(_ handle: ShotHandle, to point: CGPoint, shift: Bool) -> ShotLayer {
        var layer = self
        switch shape {
        case let .arrow(from, to):
            if handle == .start { layer.shape = .arrow(from: shift ? ShotGeometry.snap45(from: to, to: point) : point, to: to) }
            if handle == .end { layer.shape = .arrow(from: from, to: shift ? ShotGeometry.snap45(from: from, to: point) : point) }
        case .rectangle:
            layer.shape = .rectangle(ShotGeometry.resize(bounds, handle, to: point, constraint: shift ? .square : .free, minSize: 4))
        case .ellipse:
            layer.shape = .ellipse(ShotGeometry.resize(bounds, handle, to: point, constraint: shift ? .square : .free, minSize: 4))
        case let .redact(_, style):
            layer.shape = .redact(ShotGeometry.resize(bounds, handle, to: point, constraint: shift ? .square : .free, minSize: 4), style: style)
        case let .highlighter(points):
            let old = bounds
            let new = ShotGeometry.resize(old, handle, to: point, constraint: shift ? .proportional : .free, minSize: 1)
            layer.shape = .highlighter(points: points.map { ShotGeometry.map($0, from: old, to: new) })
        case let .text(_, string, size):
            let old = bounds
            let new = ShotGeometry.resize(old, handle, to: point, constraint: .proportional, minSize: 6)
            let fontSize = max(8, size * new.height / max(1, old.height))
            // Keep the corner opposite the handle where it was.
            let newSize = ShotText.size(string, fontSize: fontSize)
            let anchor = ShotGeometry.opposite(handle).position(in: old)
            let origin = CGPoint(
                x: [.topLeft, .bottomLeft].contains(handle) ? anchor.x - newSize.width : anchor.x,
                y: [.topLeft, .topRight].contains(handle) ? anchor.y - newSize.height : anchor.y
            )
            layer.shape = .text(origin: origin, string: string, fontSize: fontSize)
        case let .step(_, _, number):
            let new = ShotGeometry.resize(bounds, handle, to: point, constraint: .proportional, minSize: 16)
            layer.shape = .step(center: CGPoint(x: new.midX, y: new.midY), radius: new.width / 2, number: number)
        }
        return layer
    }
}

public enum ShotGeometry {
    public static func rect(_ a: CGPoint, _ b: CGPoint) -> CGRect {
        CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(b.x - a.x), height: abs(b.y - a.y))
    }

    /// The smallest whole-pixel rectangle around a rectangle.
    public static func integral(_ rect: CGRect) -> CGRect {
        let r = rect.standardized
        let minX = floor(r.minX + 0.001), minY = floor(r.minY + 0.001)
        let maxX = ceil(r.maxX - 0.001), maxY = ceil(r.maxY - 0.001)
        return CGRect(x: minX, y: minY, width: max(0, maxX - minX), height: max(0, maxY - minY))
    }

    public static func distance(from p: CGPoint, toSegment a: CGPoint, _ b: CGPoint) -> CGFloat {
        let dx = b.x - a.x, dy = b.y - a.y
        let lengthSquared = dx * dx + dy * dy
        guard lengthSquared > 0 else { return hypot(p.x - a.x, p.y - a.y) }
        let t = max(0, min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared))
        return hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
    }

    /// `to`, moved to the nearest multiple of 45° around `from`, at the same distance.
    public static func snap45(from: CGPoint, to: CGPoint) -> CGPoint {
        let dx = to.x - from.x, dy = to.y - from.y
        let length = hypot(dx, dy)
        guard length > 0 else { return to }
        let angle = (atan2(dy, dx) / (.pi / 4)).rounded() * (.pi / 4)
        return CGPoint(x: from.x + cos(angle) * length, y: from.y + sin(angle) * length)
    }

    /// The rectangle a drag from `start` to `end` makes; with `square`, the larger side both ways.
    public static func dragRect(from start: CGPoint, to end: CGPoint, square: Bool) -> CGRect {
        guard square else { return rect(start, end) }
        let side = max(abs(end.x - start.x), abs(end.y - start.y))
        let corner = CGPoint(x: start.x + (end.x >= start.x ? side : -side), y: start.y + (end.y >= start.y ? side : -side))
        return rect(start, corner)
    }

    public static func opposite(_ handle: ShotHandle) -> ShotHandle {
        switch handle {
        case .topLeft: .bottomRight
        case .top: .bottom
        case .topRight: .bottomLeft
        case .right: .left
        case .bottomRight: .topLeft
        case .bottom: .top
        case .bottomLeft: .topRight
        case .left: .right
        case .start: .end
        case .end: .start
        }
    }

    /// A rectangle with one handle dragged to `point`: the opposite side or corner stays put, the
    /// size never drops below `minSize`, and a handle can't be dragged past the opposite side.
    public static func resize(_ rect: CGRect, _ handle: ShotHandle, to point: CGPoint, constraint: ShotConstraint, minSize: CGFloat) -> CGRect {
        let r = rect.standardized
        var minX = r.minX, minY = r.minY, maxX = r.maxX, maxY = r.maxY
        switch handle {
        case .left, .topLeft, .bottomLeft: minX = min(point.x, maxX - minSize)
        case .right, .topRight, .bottomRight: maxX = max(point.x, minX + minSize)
        default: break
        }
        switch handle {
        case .top, .topLeft, .topRight: minY = min(point.y, maxY - minSize)
        case .bottom, .bottomLeft, .bottomRight: maxY = max(point.y, minY + minSize)
        default: break
        }
        var result = CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
        guard ShotHandle.corners.contains(handle), constraint != .free else { return result }
        // Corners with a constraint: scale both sides by the larger stretch, from the fixed corner.
        let aspect: CGFloat = constraint == .square ? 1 : (r.height > 0 ? r.width / r.height : 1)
        let width = max(result.width, result.height * aspect)
        let height = width / aspect
        let anchor = opposite(handle).position(in: r)
        let growsLeft = handle == .topLeft || handle == .bottomLeft
        let growsUp = handle == .topLeft || handle == .topRight
        result = CGRect(x: growsLeft ? anchor.x - width : anchor.x, y: growsUp ? anchor.y - height : anchor.y, width: width, height: height)
        return result
    }

    /// A point's place in one box, carried to the same place in another.
    public static func map(_ point: CGPoint, from old: CGRect, to new: CGRect) -> CGPoint {
        let fx = old.width > 0 ? (point.x - old.minX) / old.width : 0
        let fy = old.height > 0 ? (point.y - old.minY) / old.height : 0
        return CGPoint(x: new.minX + fx * new.width, y: new.minY + fy * new.height)
    }

    /// The topmost layer under a point.
    public static func layer(at point: CGPoint, in document: ShotDocument, tolerance: CGFloat) -> ShotLayer? {
        document.layers.last { $0.contains(point, tolerance: tolerance) }
    }

    /// The handle of a selected layer under a point.
    public static func handle(at point: CGPoint, of layer: ShotLayer, tolerance: CGFloat) -> ShotHandle? {
        layer.handles.first {
            let p = layer.handlePosition($0)
            return abs(p.x - point.x) <= tolerance && abs(p.y - point.y) <= tolerance
        }
    }

    /// A crop rectangle's handle under a point.
    public static func handle(at point: CGPoint, ofRect rect: CGRect, tolerance: CGFloat) -> ShotHandle? {
        ShotHandle.eight.first {
            let p = $0.position(in: rect)
            return abs(p.x - point.x) <= tolerance && abs(p.y - point.y) <= tolerance
        }
    }

    /// The shape a drag with a drawing tool makes, or nil for a drag too small to keep.
    public static func shape(for tool: ShotTool, from start: CGPoint, to end: CGPoint, shift: Bool, path: [CGPoint] = []) -> ShotShape? {
        let r = dragRect(from: start, to: end, square: shift)
        let big = r.width >= 4 || r.height >= 4
        switch tool {
        case .arrow:
            let tip = shift ? snap45(from: start, to: end) : end
            return hypot(tip.x - start.x, tip.y - start.y) >= 8 ? .arrow(from: start, to: tip) : nil
        case .rectangle: return big ? .rectangle(r) : nil
        case .ellipse: return big ? .ellipse(r) : nil
        case .redact: return big ? .redact(integral(r), style: .fill) : nil
        case .highlighter:
            if shift { return .highlighter(points: [start, end]) }
            let points = path.isEmpty ? [start, end] : path
            return .highlighter(points: points)
        case .select, .text, .step, .crop: return nil
        }
    }
}

/// Undo and redo by snapshots of the whole document (it is small), capped.
public struct ShotHistory: Sendable {
    public let cap: Int
    private var past: [ShotDocument] = []
    private var future: [ShotDocument] = []

    public init(cap: Int = 200) {
        self.cap = cap
    }

    public var canUndo: Bool { !past.isEmpty }
    public var canRedo: Bool { !future.isEmpty }

    /// Call with the document as it was, just before a change.
    public mutating func record(_ before: ShotDocument) {
        past.append(before)
        if past.count > cap { past.removeFirst(past.count - cap) }
        future.removeAll()
    }

    public mutating func undo(_ current: ShotDocument) -> ShotDocument? {
        guard let previous = past.popLast() else { return nil }
        future.append(current)
        return previous
    }

    public mutating func redo(_ current: ShotDocument) -> ShotDocument? {
        guard let next = future.popLast() else { return nil }
        past.append(current)
        return next
    }
}

/// Source pixels to view points and back. `content` is the part of the source on show (the crop,
/// or the whole capture while cropping); `zoom` is view points per source pixel; `origin` is
/// where the content's top-left sits in the (flipped) view.
public struct ShotViewTransform: Equatable, Sendable {
    public var content: CGRect
    public var zoom: CGFloat
    public var origin: CGPoint

    public static let zoomRange: ClosedRange<CGFloat> = 0.05...8

    public init(content: CGRect, zoom: CGFloat, origin: CGPoint) {
        self.content = content
        self.zoom = zoom
        self.origin = origin
    }

    public func toView(_ p: CGPoint) -> CGPoint {
        CGPoint(x: origin.x + (p.x - content.minX) * zoom, y: origin.y + (p.y - content.minY) * zoom)
    }

    public func toSource(_ v: CGPoint) -> CGPoint {
        CGPoint(x: content.minX + (v.x - origin.x) / zoom, y: content.minY + (v.y - origin.y) / zoom)
    }

    public func toView(_ r: CGRect) -> CGRect {
        let a = toView(CGPoint(x: r.minX, y: r.minY))
        return CGRect(x: a.x, y: a.y, width: r.width * zoom, height: r.height * zoom)
    }

    /// The whole content inside the view with a margin, never larger than actual size.
    public static func fitted(content: CGRect, in view: CGSize, margin: CGFloat, backingScale: CGFloat) -> ShotViewTransform {
        let room = CGSize(width: max(1, view.width - margin * 2), height: max(1, view.height - margin * 2))
        let fit = min(room.width / max(1, content.width), room.height / max(1, content.height))
        let zoom = min(fit, 1 / max(1, backingScale))
        return centered(content: content, in: view, zoom: zoom)
    }

    /// One source pixel to one screen pixel.
    public static func actualSize(content: CGRect, in view: CGSize, backingScale: CGFloat) -> ShotViewTransform {
        centered(content: content, in: view, zoom: 1 / max(1, backingScale))
    }

    public static func centered(content: CGRect, in view: CGSize, zoom: CGFloat) -> ShotViewTransform {
        let z = min(max(zoom, zoomRange.lowerBound), zoomRange.upperBound)
        return ShotViewTransform(
            content: content,
            zoom: z,
            origin: CGPoint(x: ((view.width - content.width * z) / 2).rounded(), y: ((view.height - content.height * z) / 2).rounded())
        )
    }

    /// Zoomed by a factor, keeping the source point under `anchor` (a view point) where it is.
    public func zoomed(by factor: CGFloat, around anchor: CGPoint) -> ShotViewTransform {
        let fixed = toSource(anchor)
        let z = min(max(zoom * factor, Self.zoomRange.lowerBound), Self.zoomRange.upperBound)
        return ShotViewTransform(
            content: content,
            zoom: z,
            origin: CGPoint(x: anchor.x - (fixed.x - content.minX) * z, y: anchor.y - (fixed.y - content.minY) * z)
        )
    }
}

/// Copy Text (R13): Vision's lines, put in reading order.
public enum TextReadingOrder {
    public struct Piece: Equatable, Sendable {
        public var text: String
        /// In the picture, origin top-left, any unit.
        public var box: CGRect

        public init(text: String, box: CGRect) {
            self.text = text
            self.box = box
        }
    }

    /// Top to bottom; pieces whose boxes share most of their height are one line, left to right.
    public static func text(_ pieces: [Piece]) -> String {
        var lines: [[Piece]] = []
        for piece in pieces.sorted(by: { $0.box.midY < $1.box.midY }) {
            if let index = lines.indices.last, sameLine(lines[index], piece) {
                lines[index].append(piece)
            } else {
                lines.append([piece])
            }
        }
        return lines
            .map { $0.sorted { $0.box.minX < $1.box.minX }.map(\.text).joined(separator: " ") }
            .joined(separator: "\n")
    }

    private static func sameLine(_ line: [Piece], _ piece: Piece) -> Bool {
        let top = line.map(\.box.minY).min() ?? 0
        let bottom = line.map(\.box.maxY).max() ?? 0
        let overlap = min(bottom, piece.box.maxY) - max(top, piece.box.minY)
        let shorter = min(bottom - top, piece.box.height)
        return shorter > 0 && overlap >= shorter * 0.5
    }

    public static func wordCount(_ text: String) -> Int {
        text.split(whereSeparator: { $0.isWhitespace }).count
    }
}
