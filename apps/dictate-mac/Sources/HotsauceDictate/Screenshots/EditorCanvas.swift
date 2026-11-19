import AppKit
import DictateCore

/// The editor's drawing surface (docs/PLAN-screenshots.md R11): shows the document through
/// `ShotRenderer` at any zoom and turns the mouse and keys into edits of `ShotDocument`. All the
/// maths (hit testing, handles, resizing, history, zoom) is in DictateCore; this is the glue.
final class EditorCanvas: NSView, NSTextViewDelegate {
    let source: CGImage

    private(set) var document: ShotDocument {
        didSet {
            selection = selection.intersection(document.allIDs)
            needsDisplay = true
            onChange()
        }
    }
    private var history = ShotHistory()
    var selection: Set<Int> = [] {
        didSet {
            needsDisplay = true
            onSelectionChange()
        }
    }
    var tool: ShotTool = .arrow {
        didSet {
            guard tool != oldValue else { return }
            commitText()
            if tool == .crop {
                cropRect = document.visibleRect
                selection = []
            } else {
                cropRect = nil
            }
            refit(keepZoom: true)
            onToolChange()
        }
    }
    var color = ShotPalette.defaultColor
    var width = ShotPalette.defaultWidth

    var onChange: () -> Void = {}
    var onSelectionChange: () -> Void = {}
    var onToolChange: () -> Void = {}
    var onCopy: () -> Void = {}
    var onSave: (_ saveAs: Bool) -> Void = { _ in }

    private(set) var transform = ShotViewTransform(content: .zero, zoom: 1, origin: .zero)
    /// Until the person zooms or scrolls, a resize refits the picture.
    private var userZoomed = false
    /// The crop being edited while the Crop tool is on, in source pixels.
    private(set) var cropRect: CGRect?

    private enum Drag {
        case none
        case creating(start: CGPoint, end: CGPoint, path: [CGPoint], shift: Bool)
        case moving(last: CGPoint)
        case resizing(original: ShotLayer, handle: ShotHandle)
        case cropping(start: CGRect, handle: ShotHandle?, from: CGPoint)
        /// A new crop, dragged out from where the mouse went down.
        case newCrop(anchor: CGPoint)
    }
    private var drag = Drag.none

    private var textView: NSTextView?
    private var editingText: (id: Int?, origin: CGPoint, fontSize: CGFloat, color: ShotColor, before: ShotDocument)?

    static let handleSize: CGFloat = 9
    static let textSize: CGFloat = 36

    init(source: CGImage, document: ShotDocument) {
        self.source = source
        self.document = document
        super.init(frame: CGRect(x: 0, y: 0, width: 800, height: 500))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    var canUndo: Bool { history.canUndo }
    var canRedo: Bool { history.canRedo }

    // MARK: Changes

    /// One undoable change. A drag under way ends first, so its step comes before this one.
    func change(_ body: (inout ShotDocument) -> Void) {
        finishDrag()
        let before = document
        var after = document
        body(&after)
        guard after != before else { return }
        history.record(before)
        document = after
    }

    /// A move or resize under way is kept as its own undo step before anything else happens.
    private func finishDrag() {
        history.endGesture(document)
        if case .creating = drag { needsDisplay = true }
        drag = .none
    }

    func undo() {
        finishDrag()
        commitText()
        if let previous = history.undo(document) { document = previous; refit(keepZoom: true) }
    }

    func redo() {
        finishDrag()
        commitText()
        if let next = history.redo(document) { document = next; refit(keepZoom: true) }
    }

    func applyColor(_ color: ShotColor) {
        self.color = color
        // While typing, the colour belongs to the text being typed (kept when it is committed).
        if let textView, editingText != nil {
            editingText?.color = color
            textView.textColor = NSColor(cgColor: color.cgColor)
            return
        }
        if !selection.isEmpty { change { $0.setColor(selection, color) } }
    }

    func applyWidth(_ width: CGFloat) {
        self.width = width
        guard editingText == nil else { return }
        if !selection.isEmpty { change { $0.setWidth(selection, width) } }
    }

    func deleteSelection() {
        guard !selection.isEmpty else { return }
        change { $0.delete(selection) }
    }

    func duplicateSelection() {
        guard !selection.isEmpty else { return }
        var copies: Set<Int> = []
        change { copies = $0.duplicate(selection) }
        selection = copies
    }

    func applyCrop() {
        guard let cropRect else { return }
        change { $0.setCrop(cropRect) }
        tool = .select
    }

    func cancelCrop() {
        tool = .select
    }

    // MARK: Zoom

    private var backingScale: CGFloat { window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2 }
    private var content: CGRect { tool == .crop ? document.sourceBounds : document.visibleRect }

    func refit(keepZoom: Bool = false) {
        if keepZoom, userZoomed {
            transform = transform.withContent(content)
        } else {
            userZoomed = false
            transform = .fitted(content: content, in: bounds.size, margin: 24, backingScale: backingScale)
        }
        positionTextView()
        needsDisplay = true
    }

    func zoomToFit() { userZoomed = false; refit() }

    func zoomActualSize() {
        userZoomed = true
        transform = .actualSize(content: content, in: bounds.size, backingScale: backingScale)
        positionTextView()
        needsDisplay = true
    }

    func zoom(by factor: CGFloat, around point: CGPoint? = nil) {
        userZoomed = true
        transform = transform.zoomed(by: factor, around: point ?? CGPoint(x: bounds.midX, y: bounds.midY))
        positionTextView()
        needsDisplay = true
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        if !userZoomed { refit() }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        refit()
    }

    override func magnify(with event: NSEvent) {
        zoom(by: 1 + event.magnification, around: convert(event.locationInWindow, from: nil))
    }

    override func scrollWheel(with event: NSEvent) {
        if event.modifierFlags.contains(.command) {
            zoom(by: 1 + event.scrollingDeltaY * 0.01, around: convert(event.locationInWindow, from: nil))
            return
        }
        userZoomed = true
        transform.origin.x += event.scrollingDeltaX
        transform.origin.y += event.scrollingDeltaY
        positionTextView()
        needsDisplay = true
    }

    // MARK: Drawing

    override func draw(_ dirtyRect: NSRect) {
        NSColor(Hotsauce.sunk).setFill()
        bounds.fill()
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        let shown = transform.toView(content)
        context.saveGState()
        context.setShadow(offset: CGSize(width: 0, height: 2), blur: 12, color: NSColor.black.withAlphaComponent(0.25).cgColor)
        context.setFillColor(NSColor.white.cgColor)
        context.fill(shown)
        context.restoreGState()

        context.saveGState()
        context.clip(to: shown)
        context.translateBy(x: transform.origin.x, y: transform.origin.y)
        context.scaleBy(x: transform.zoom, y: transform.zoom)
        context.translateBy(x: -content.minX, y: -content.minY)
        var shownDocument = document
        if case let .creating(start, end, path, shift) = drag,
           let shape = ShotGeometry.shape(for: tool, from: start, to: end, shift: shift, path: path) {
            shownDocument.add(shape, color: tool == .redact ? ShotPalette.redactColor : color, width: width)
        }
        let skipping: Set<Int> = editingText?.id.map { [$0] } ?? []
        ShotRenderer.draw(shownDocument, source: source, in: context, skipping: skipping)
        context.restoreGState()

        if let cropRect { drawCrop(cropRect, in: context) }
        drawSelection(in: context)
    }

    private func drawCrop(_ rect: CGRect, in context: CGContext) {
        let shown = transform.toView(content)
        let crop = transform.toView(rect)
        context.saveGState()
        context.addRect(shown)
        context.addRect(crop)
        context.setFillColor(NSColor.black.withAlphaComponent(0.5).cgColor)
        context.fillPath(using: .evenOdd)
        context.setStrokeColor(NSColor.white.cgColor)
        context.setLineWidth(1)
        // Thirds, to line things up.
        for i in 1...2 {
            let x = crop.minX + crop.width * CGFloat(i) / 3, y = crop.minY + crop.height * CGFloat(i) / 3
            context.move(to: CGPoint(x: x, y: crop.minY)); context.addLine(to: CGPoint(x: x, y: crop.maxY))
            context.move(to: CGPoint(x: crop.minX, y: y)); context.addLine(to: CGPoint(x: crop.maxX, y: y))
        }
        context.setStrokeColor(NSColor.white.withAlphaComponent(0.35).cgColor)
        context.strokePath()
        context.setStrokeColor(NSColor.white.cgColor)
        context.setLineWidth(2)
        context.stroke(crop.insetBy(dx: -1, dy: -1))
        context.restoreGState()
        for handle in ShotHandle.allCases where handle != .start && handle != .end {
            drawHandle(at: handle.position(in: crop), in: context)
        }
    }

    private func drawSelection(in context: CGContext) {
        guard editingText == nil else { return }
        let accent = NSColor(Hotsauce.ember).cgColor
        for id in selection {
            guard let layer = document.layer(id) else { continue }
            if case let .arrow(from, to) = layer.shape {
                context.saveGState()
                context.setStrokeColor(accent)
                context.setLineWidth(1)
                context.setLineDash(phase: 0, lengths: [4, 3])
                context.move(to: transform.toView(from))
                context.addLine(to: transform.toView(to))
                context.strokePath()
                context.restoreGState()
            } else {
                let box = transform.toView(layer.bounds).insetBy(dx: -4, dy: -4)
                context.saveGState()
                context.setStrokeColor(accent)
                context.setLineWidth(1)
                context.setLineDash(phase: 0, lengths: [4, 3])
                context.stroke(box)
                context.restoreGState()
            }
            // Handles only on a single selection, where dragging one is unambiguous.
            if selection.count == 1 {
                for handle in layer.handles { drawHandle(at: transform.toView(layer.handlePosition(handle)), in: context) }
            }
        }
    }

    private func drawHandle(at point: CGPoint, in context: CGContext) {
        let size = Self.handleSize
        let rect = CGRect(x: (point.x - size / 2).rounded() + 0.5, y: (point.y - size / 2).rounded() + 0.5, width: size, height: size)
        context.saveGState()
        context.setShadow(offset: .zero, blur: 2, color: NSColor.black.withAlphaComponent(0.4).cgColor)
        context.setFillColor(NSColor.white.cgColor)
        context.fill(rect)
        context.restoreGState()
        context.setStrokeColor(NSColor(Hotsauce.ember).cgColor)
        context.setLineWidth(1.5)
        context.stroke(rect)
    }

    // MARK: Mouse

    /// View points to source pixels, and a few points' slack in source pixels.
    private func sourcePoint(_ event: NSEvent) -> CGPoint { transform.toSource(convert(event.locationInWindow, from: nil)) }
    private var tolerance: CGFloat { 6 / transform.zoom }
    private var handleTolerance: CGFloat { (Self.handleSize / 2 + 3) / transform.zoom }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        commitText()
        let p = sourcePoint(event)
        let shift = event.modifierFlags.contains(.shift)

        if tool == .crop, let cropRect {
            if let handle = ShotGeometry.handle(at: p, ofRect: cropRect, tolerance: handleTolerance) {
                drag = .cropping(start: cropRect, handle: handle, from: p)
            } else if cropRect.contains(p) {
                drag = .cropping(start: cropRect, handle: nil, from: p)
            } else {
                // A fresh crop from here, dragged any way (from the nearest edge when outside).
                drag = .newCrop(anchor: p)
            }
            return
        }

        // A handle of the one selected layer wins with any tool.
        if selection.count == 1, let id = selection.first, let layer = document.layer(id),
           let handle = ShotGeometry.handle(at: p, of: layer, tolerance: handleTolerance) {
            history.beginGesture(document)
            drag = .resizing(original: layer, handle: handle)
            return
        }

        switch tool {
        case .select:
            if let hit = ShotGeometry.layer(at: p, in: document, tolerance: tolerance) {
                if shift, selection.contains(hit.id) {
                    // Shift-click takes it out of the selection; nothing to drag.
                    selection.remove(hit.id)
                    return
                } else if shift {
                    selection.insert(hit.id)
                } else if !selection.contains(hit.id) {
                    selection = [hit.id]
                }
                if event.clickCount == 2, case .text = hit.shape { beginEditingText(hit) ; return }
                history.beginGesture(document)
                drag = .moving(last: p)
            } else {
                selection = []
            }
        case .text:
            if let hit = ShotGeometry.layer(at: p, in: document, tolerance: tolerance), case .text = hit.shape {
                beginEditingText(hit)
            } else {
                beginNewText(at: p)
            }
        case .step:
            let radius = max(18, width * 3.5)
            var id = 0
            change { id = $0.add(.step(center: p, radius: radius, number: 0), color: color, width: width) }
            selection = [id]
        case .arrow, .rectangle, .ellipse, .highlighter, .redact:
            selection = []
            drag = .creating(start: p, end: p, path: [p], shift: shift)
        case .crop:
            break
        }
    }

    override func mouseDragged(with event: NSEvent) {
        let p = sourcePoint(event)
        let shift = event.modifierFlags.contains(.shift)
        switch drag {
        case .none:
            break
        case let .creating(start, _, path, _):
            drag = .creating(start: start, end: p, path: path + [p], shift: shift)
            needsDisplay = true
        case let .moving(last):
            var moved = document
            moved.move(selection, by: CGVector(dx: p.x - last.x, dy: p.y - last.y))
            document = moved
            drag = .moving(last: p)
        case let .resizing(original, handle):
            var resized = document
            resized.update(original.resized(handle, to: p, shift: shift))
            document = resized
        case let .newCrop(anchor):
            cropRect = ShotGeometry.cropRect(from: anchor, to: p, square: shift, in: document.sourceBounds)
            needsDisplay = true
        case let .cropping(start, handle, from):
            let bounds = document.sourceBounds
            if let handle {
                let resized = ShotGeometry.resize(start, handle, to: p, constraint: shift ? .square : .free, minSize: 8).intersection(bounds)
                // Dragged wholly outside the capture: keep the last good crop.
                if !resized.isNull { cropRect = resized }
            } else {
                var moved = start.offsetBy(dx: p.x - from.x, dy: p.y - from.y)
                moved.origin.x = min(max(moved.minX, bounds.minX), bounds.maxX - moved.width)
                moved.origin.y = min(max(moved.minY, bounds.minY), bounds.maxY - moved.height)
                cropRect = moved
            }
            needsDisplay = true
        }
    }

    override func mouseUp(with event: NSEvent) {
        let finished = drag
        drag = .none
        switch finished {
        case let .creating(start, end, path, shift):
            guard let shape = ShotGeometry.shape(for: tool, from: start, to: end, shift: shift, path: path) else {
                needsDisplay = true
                return
            }
            let layerColor = tool == .redact ? ShotPalette.redactColor : color
            var id = 0
            change { id = $0.add(shape, color: layerColor, width: width) }
            selection = [id]
        case .moving, .resizing:
            history.endGesture(document)
        case .cropping, .newCrop:
            if let crop = cropRect, crop.isNull || crop.width < 8 || crop.height < 8 { cropRect = document.visibleRect }
            needsDisplay = true
        case .none:
            break
        }
    }

    // MARK: Keys

    override func keyDown(with event: NSEvent) {
        let shift = event.modifierFlags.contains(.shift)
        switch event.keyCode {
        case 53: // Esc
            finishDrag()
            if tool == .crop { cancelCrop() } else if !selection.isEmpty { selection = [] } else { drag = .none; needsDisplay = true }
        case 36, 76: // Return
            if tool == .crop { applyCrop() }
        case 51, 117:
            deleteSelection()
        case 123: nudge(-1, 0, shift)
        case 124: nudge(1, 0, shift)
        case 125: nudge(0, 1, shift)
        case 126: nudge(0, -1, shift)
        default:
            let plain = event.modifierFlags.intersection([.command, .control, .option]).isEmpty
            if plain, let character = event.charactersIgnoringModifiers?.first, let picked = ShotTool.forKey(character) {
                tool = picked
            } else {
                super.keyDown(with: event)
            }
        }
    }

    private func nudge(_ dx: Int, _ dy: Int, _ shift: Bool) {
        guard !selection.isEmpty else { return }
        change { $0.nudge(selection, dx: dx, dy: dy, shift: shift) }
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard window?.isKeyWindow == true, event.modifierFlags.contains(.command) else { return super.performKeyEquivalent(with: event) }
        // While typing, the text field gets ⌘Z, ⌘A, ⌘C and friends.
        if textView != nil { return super.performKeyEquivalent(with: event) }
        let shift = event.modifierFlags.contains(.shift)
        switch event.charactersIgnoringModifiers?.lowercased() {
        case "z": shift ? redo() : undo()
        case "a": selection = document.allIDs
        case "d": duplicateSelection()
        case "c": onCopy()
        case "s": onSave(shift)
        case "=", "+": zoom(by: 1.25)
        case "-": zoom(by: 0.8)
        case "0": zoomToFit()
        case "1": zoomActualSize()
        default: return super.performKeyEquivalent(with: event)
        }
        return true
    }

    // MARK: Text

    private func beginNewText(at point: CGPoint) {
        editingText = (nil, point, max(Self.textSize, width * 5), color, document)
        showTextView(string: "", color: color)
    }

    private func beginEditingText(_ layer: ShotLayer) {
        guard case let .text(origin, string, size) = layer.shape else { return }
        selection = [layer.id]
        editingText = (layer.id, origin, size, layer.color, document)
        showTextView(string: string, color: layer.color)
        needsDisplay = true
    }

    private func showTextView(string: String, color: ShotColor) {
        let view = EditorTextView(frame: .zero)
        view.isRichText = false
        view.drawsBackground = false
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        view.isHorizontallyResizable = true
        view.textContainer?.widthTracksTextView = false
        view.textContainer?.containerSize = CGSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        view.textColor = NSColor(cgColor: color.cgColor)
        view.insertionPointColor = NSColor(cgColor: color.cgColor) ?? .labelColor
        view.string = string
        view.delegate = self
        view.onEscape = { [weak self] in self?.commitText() }
        view.setAccessibilityLabel("Text")
        addSubview(view)
        textView = view
        positionTextView()
        window?.makeFirstResponder(view)
        view.selectAll(nil)
    }

    private func positionTextView() {
        guard let textView, let editingText else { return }
        let font = NSFont.systemFont(ofSize: editingText.fontSize * transform.zoom, weight: .bold)
        textView.font = font
        let size = ShotText.size(textView.string.isEmpty ? " " : textView.string, fontSize: editingText.fontSize)
        let origin = transform.toView(editingText.origin)
        textView.frame = CGRect(x: origin.x, y: origin.y, width: (size.width + editingText.fontSize) * transform.zoom, height: size.height * transform.zoom + 2)
    }

    func textDidChange(_ notification: Notification) {
        positionTextView()
    }

    /// Esc, a click elsewhere, or another tool: the text is kept, or dropped when empty.
    func commitText() {
        guard let textView, let editing = editingText else { return }
        let string = textView.string
        self.textView = nil
        editingText = nil
        textView.removeFromSuperview()
        window?.makeFirstResponder(self)
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        var after = editing.before
        if let id = editing.id, var layer = after.layer(id) {
            if trimmed.isEmpty {
                after.delete([id])
            } else {
                layer.shape = .text(origin: editing.origin, string: string, fontSize: editing.fontSize)
                layer.color = editing.color
                after.update(layer)
            }
        } else if !trimmed.isEmpty {
            let id = after.add(.text(origin: editing.origin, string: string, fontSize: editing.fontSize), color: editing.color, width: width)
            selection = [id]
        }
        if after != editing.before {
            history.record(editing.before)
            document = after
        }
        needsDisplay = true
    }
}

/// Esc ends typing instead of beeping.
private final class EditorTextView: NSTextView {
    var onEscape: () -> Void = {}
    override func cancelOperation(_ sender: Any?) { onEscape() }
}
