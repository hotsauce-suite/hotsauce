import AppKit
import DictateCore
import SwiftUI

// The overlay while choosing what to capture (docs/PLAN-screenshots.md R8): one borderless panel
// per display, above everything, showing that display's frozen frame dimmed. Drag for an area,
// click a window for that window, click the desktop for the whole display. The geometry is
// `CaptureGeometry` in DictateCore; this file only draws and forwards the mouse.

/// What the marks over the frozen frame show. Rects and points are local to the display, in
/// points from its top-left.
struct CaptureMarks {
    enum Readout: Equatable {
        case position(x: Int, y: Int)
        case size(width: Int, height: Int)
    }

    /// The pointer, when it is over this display.
    var pointer: CGPoint?
    /// The rectangle being dragged.
    var drag: CGRect?
    /// What a click would pick: a window, or the whole display (`wholeDisplay`).
    var hover: CGRect?
    var wholeDisplay = false
    var readout: Readout?
    /// The one-line how-to at the top, until the first drag.
    var showsHint = false

    static let hint = "Drag for an area  ·  Click a window  ·  Click the desktop for the whole screen  ·  Esc to cancel"

    /// The overlay is always dark, so its colours are the theme's night ones.
    private static func color(_ color: Color, alpha: CGFloat = 1) -> NSColor {
        var resolved = NSColor(color)
        NSAppearance(named: .darkAqua)?.performAsCurrentDrawingAppearance {
            resolved = NSColor(cgColor: NSColor(color).cgColor) ?? resolved
        }
        return resolved.withAlphaComponent(alpha)
    }

    static let dim = NSColor.black.withAlphaComponent(0.42)
    static var accent: NSColor { color(Hotsauce.ember) }
    /// The same dark pill as the dictation overlay.
    static var pill: NSColor { color(Hotsauce.raised, alpha: 0.94) }
    static var pillText: NSColor { NSColor.white.withAlphaComponent(0.92) }

    /// Draws into the current, flipped graphics context (origin top-left), over the frozen frame.
    func draw(in bounds: CGRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        let clear = drag ?? (wholeDisplay ? nil : hover)

        // Everything dimmed but what would be captured.
        context.saveGState()
        context.addRect(bounds)
        if let clear { context.addRect(clear) }
        context.setFillColor(Self.dim.cgColor)
        context.fillPath(using: .evenOdd)
        context.restoreGState()

        if let pick = drag ?? hover {
            let accent = Self.accent
            if drag == nil {
                // A window or the screen under the pointer: a light wash and an outline.
                context.setFillColor(accent.withAlphaComponent(wholeDisplay ? 0.06 : 0.10).cgColor)
                context.fill(pick)
            }
            context.setStrokeColor(accent.cgColor)
            context.setLineWidth(2)
            context.stroke(pick.insetBy(dx: 1, dy: 1))
        }

        if let pointer { drawGuides(at: pointer, in: bounds, context: context) }
        if let pointer, let readout { drawReadout(readout, at: pointer, in: bounds) }
        if showsHint { drawHint(in: bounds) }
    }

    /// Thin crosshair lines through the pointer, light with a dark edge so they show on anything.
    private func drawGuides(at point: CGPoint, in bounds: CGRect, context: CGContext) {
        let x = point.x.rounded(.down) + 0.5
        let y = point.y.rounded(.down) + 0.5
        for (color, offset) in [(NSColor.black.withAlphaComponent(0.35), CGFloat(1)), (NSColor.white.withAlphaComponent(0.6), 0)] {
            context.setStrokeColor(color.cgColor)
            context.setLineWidth(1)
            context.move(to: CGPoint(x: bounds.minX, y: y + offset))
            context.addLine(to: CGPoint(x: bounds.maxX, y: y + offset))
            context.move(to: CGPoint(x: x + offset, y: bounds.minY))
            context.addLine(to: CGPoint(x: x + offset, y: bounds.maxY))
            context.strokePath()
        }
    }

    private func drawReadout(_ readout: Readout, at point: CGPoint, in bounds: CGRect) {
        let text: String
        switch readout {
        case let .position(x, y): text = "\(x), \(y)"
        case let .size(width, height): text = "\(width) × \(height)"
        }
        let size = pillSize(for: text, font: Self.readoutFont)
        // Below and to the right of the pointer; flipped to the other side near an edge.
        var origin = CGPoint(x: point.x + 14, y: point.y + 18)
        if origin.x + size.width > bounds.maxX - 4 { origin.x = point.x - 14 - size.width }
        if origin.y + size.height > bounds.maxY - 4 { origin.y = point.y - 18 - size.height }
        drawPill(text, font: Self.readoutFont, in: CGRect(origin: origin, size: size))
    }

    private func drawHint(in bounds: CGRect) {
        let size = pillSize(for: Self.hint, font: Self.hintFont)
        let origin = CGPoint(x: bounds.midX - size.width / 2, y: bounds.minY + max(48, bounds.height * 0.08))
        drawPill(Self.hint, font: Self.hintFont, in: CGRect(origin: origin, size: size))
    }

    static let readoutFont = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)
    static let hintFont = NSFont.systemFont(ofSize: 12, weight: .medium)

    private func pillSize(for text: String, font: NSFont) -> CGSize {
        let size = (text as NSString).size(withAttributes: [.font: font])
        return CGSize(width: ceil(size.width) + 24, height: 26)
    }

    private func drawPill(_ text: String, font: NSFont, in rect: CGRect) {
        let path = NSBezierPath(roundedRect: rect, xRadius: rect.height / 2, yRadius: rect.height / 2)
        Self.pill.setFill()
        path.fill()
        NSColor.white.withAlphaComponent(0.08).setStroke()
        path.lineWidth = 1
        path.stroke()
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: Self.pillText]
        let textSize = (text as NSString).size(withAttributes: attributes)
        (text as NSString).draw(at: CGPoint(x: rect.midX - textSize.width / 2, y: rect.midY - textSize.height / 2), withAttributes: attributes)
    }
}

/// A panel that can take keys (Esc) without activating the app.
private final class CapturePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/// The overlay on every display at once.
@MainActor
final class CaptureOverlay {
    /// A click or drag picked something on this display.
    var onPick: (FrozenDisplay, CaptureSelection) -> Void = { _, _ in }
    /// Esc, a right-click, or the shortcut pressed again (when the key tap isn't running).
    var onCancel: () -> Void = {}
    var shortcut: () -> ScreenshotShortcut = { .default }

    private var panels: [NSPanel] = []
    private var cursorPushed = false

    var isVisible: Bool { !panels.isEmpty }
    var windowNumbers: Set<Int> { Set(panels.map(\.windowNumber)) }

    func show(_ frozen: FrozenScreens, ownPID: Int32) {
        close()
        let windows = CaptureGeometry.pickableWindows(frozen.windows, ownPID: ownPID)
        let mouse = NSEvent.mouseLocation
        let animates = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        for display in frozen.displays {
            let panel = CapturePanel(
                contentRect: display.screen.frame,
                styleMask: [.borderless, .nonactivatingPanel],
                backing: .buffered,
                defer: false
            )
            panel.level = .screenSaver
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
            panel.isOpaque = true
            panel.backgroundColor = .black
            panel.hasShadow = false
            panel.hidesOnDeactivate = false
            panel.isReleasedWhenClosed = false
            panel.acceptsMouseMovedEvents = true
            panel.animationBehavior = .none
            let view = CaptureOverlayView(frozen: display, windows: windows)
            view.frame = CGRect(origin: .zero, size: display.screen.frame.size)
            view.onPick = { [weak self] selection in self?.onPick(display, selection) }
            view.onCancel = { [weak self] in self?.onCancel() }
            view.shortcut = { [weak self] in self?.shortcut() ?? .default }
            panel.contentView = view
            panel.setFrame(display.screen.frame, display: false)
            if animates { panel.alphaValue = 0 }
            panel.orderFrontRegardless()
            if display.screen.frame.contains(mouse) {
                panel.makeKey()
                panel.makeFirstResponder(view.marks)
                view.marks.pointerMoved(toScreen: mouse)
            }
            panels.append(panel)
        }
        if animates {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.12
                for panel in panels { panel.animator().alphaValue = 1 }
            }
        }
        NSCursor.crosshair.push()
        cursorPushed = true
    }

    func close() {
        for panel in panels { panel.orderOut(nil) }
        // Closed from inside a panel's own mouseUp: keep them alive until that event is done.
        let closed = panels
        DispatchQueue.main.async { _ = closed }
        panels = []
        if cursorPushed {
            NSCursor.pop()
            cursorPushed = false
        }
    }
}

/// One display: the frozen frame as a layer, with the marks drawn over it.
final class CaptureOverlayView: NSView {
    let marks: CaptureMarksView
    var onPick: (CaptureSelection) -> Void {
        get { marks.onPick }
        set { marks.onPick = newValue }
    }
    var onCancel: () -> Void {
        get { marks.onCancel }
        set { marks.onCancel = newValue }
    }
    var shortcut: () -> ScreenshotShortcut {
        get { marks.shortcut }
        set { marks.shortcut = newValue }
    }

    init(frozen: FrozenDisplay, windows: [CaptureWindow]) {
        marks = CaptureMarksView(frozen: frozen, windows: windows)
        super.init(frame: .zero)
        wantsLayer = true
        layer?.contents = frozen.image
        layer?.contentsGravity = .resize
        marks.autoresizingMask = [.width, .height]
        addSubview(marks)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        marks.frame = bounds
    }
}

/// The dim, the pick's outline, the crosshair and the readout; and the mouse.
final class CaptureMarksView: NSView {
    var onPick: (CaptureSelection) -> Void = { _ in }
    var onCancel: () -> Void = {}
    var shortcut: () -> ScreenshotShortcut = { .default }

    private let display: CaptureDisplay
    private let windows: [CaptureWindow]
    /// Global top-left points.
    private var pointer: CGPoint?
    private var dragStart: CGPoint?
    private var dragged = false

    init(frozen: FrozenDisplay, windows: [CaptureWindow]) {
        display = frozen.display
        self.windows = windows
        super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect, .cursorUpdate], owner: self))
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .crosshair)
    }

    override func cursorUpdate(with event: NSEvent) {
        NSCursor.crosshair.set()
    }

    /// The view's flipped local point is the display's local point, so global = origin + local.
    private func global(_ event: NSEvent) -> CGPoint {
        let local = convert(event.locationInWindow, from: nil)
        return CGPoint(x: display.frame.minX + local.x, y: display.frame.minY + local.y)
    }

    /// For the panel under the pointer when the overlay opens: AppKit global coordinates.
    func pointerMoved(toScreen appKitPoint: NSPoint) {
        guard let window else { return }
        let local = convert(window.convertPoint(fromScreen: appKitPoint), from: nil)
        pointer = CGPoint(x: display.frame.minX + local.x, y: display.frame.minY + local.y)
        needsDisplay = true
    }

    /// For the self-test render: put the pointer (and a drag) where a person would.
    func simulate(pointer: CGPoint, dragFrom start: CGPoint? = nil) {
        self.pointer = pointer
        dragStart = start
        dragged = start.map { !CaptureGeometry.isClick(from: $0, to: pointer) } ?? false
    }

    override func mouseMoved(with event: NSEvent) {
        pointer = global(event)
        NSCursor.crosshair.set()
        if window?.isKeyWindow == false { window?.makeKey() }
        needsDisplay = true
    }

    override func mouseEntered(with event: NSEvent) {
        mouseMoved(with: event)
    }

    override func mouseExited(with event: NSEvent) {
        guard dragStart == nil else { return }
        pointer = nil
        needsDisplay = true
    }

    override func mouseDown(with event: NSEvent) {
        let point = global(event)
        dragStart = point
        pointer = point
        dragged = false
        needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        guard let start = dragStart else { return }
        pointer = global(event)
        if let pointer, !CaptureGeometry.isClick(from: start, to: pointer) { dragged = true }
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        guard let start = dragStart else { return }
        let end = global(event)
        dragStart = nil
        onPick(CaptureGeometry.selection(from: start, to: end, windows: windows, display: display))
    }

    override func rightMouseDown(with event: NSEvent) {
        onCancel()
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 || shortcut().matches(keyCode: Int64(event.keyCode), flags: UInt64(event.modifierFlags.rawValue)) {
            onCancel()
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        marks().draw(in: bounds)
    }

    /// The marks for where the pointer is now.
    func marks() -> CaptureMarks {
        var marks = CaptureMarks()
        guard let pointer else { return marks }
        let origin = display.frame.origin
        func local(_ rect: CGRect) -> CGRect { rect.offsetBy(dx: -origin.x, dy: -origin.y) }
        marks.pointer = CGPoint(x: pointer.x - origin.x, y: pointer.y - origin.y)
        if let start = dragStart, dragged {
            let rect = CaptureGeometry.dragRect(from: start, to: pointer).intersection(display.frame)
            marks.drag = rect.isNull ? nil : local(rect)
            let size = display.pixelSize(of: rect)
            marks.readout = .size(width: size.width, height: size.height)
            return marks
        }
        let pick = CaptureGeometry.hover(at: pointer, windows: windows, display: display)
        marks.hover = local(pick.rect)
        if case .display = pick.kind {
            marks.wholeDisplay = true
            let position = display.pixelPoint(for: pointer)
            marks.readout = .position(x: position.x, y: position.y)
        } else {
            let size = display.pixelSize(of: pick.rect)
            marks.readout = .size(width: size.width, height: size.height)
        }
        marks.showsHint = dragStart == nil
        return marks
    }
}
