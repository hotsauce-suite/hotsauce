import AppKit
import DictateCore
import SwiftUI

/// One capture: the picture, its PNG, and where it was saved.
struct Screenshot {
    let image: CGImage
    let png: Data
    /// Nil when saving failed; the clipboard still has it.
    let fileURL: URL?
    let takenAt: Date
}

/// The small preview in the corner after a capture (docs/PLAN-screenshots.md R10): fades after 7
/// seconds, pauses while hovered, Edit / Copy / Share / Pin / Close on hover, and the picture
/// drags out as a file. The countdown is `ScreenshotPreviewTimer` in DictateCore.
@MainActor
final class ScreenshotPreview {
    /// Slice 3 supplies the editor; until then Edit is shown disabled ("Coming next").
    var onEdit: ((Screenshot) -> Void)?
    /// Slice 4 supplies sharing; until then Share is hidden.
    var onShare: ((Screenshot) -> Void)?
    var onCopy: (Screenshot) -> Void = { _ in }

    private var panel: NSPanel?
    private var content: ScreenshotPreviewView?
    private var shot: Screenshot?
    private var timer = ScreenshotPreviewTimer(shownAt: 0)
    private var closeTimer: Timer?

    var windowNumbers: Set<Int> { panel.map { [$0.windowNumber] } ?? [] }

    private static var now: TimeInterval { ProcessInfo.processInfo.systemUptime }
    private static var animates: Bool { !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    /// Shows a new capture in the corner of its display, replacing any preview already up.
    func show(_ shot: Screenshot, on screen: NSScreen) {
        dismiss(animated: false)
        self.shot = shot
        let view = ScreenshotPreviewView(shot: shot)
        view.hasEdit = true
        view.editEnabled = onEdit != nil
        view.hasShare = onShare != nil
        view.action = { [weak self] action in self?.perform(action) }
        view.hoverChanged = { [weak self] inside in self?.hover(inside) }
        view.dragChanged = { [weak self] active in self?.dragging(active) }
        let size = view.fittingSize
        let visible = screen.visibleFrame
        let frame = NSRect(x: visible.maxX - 16 - size.width, y: visible.minY + 16, width: size.width, height: size.height)
        let panel = PreviewPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.isMovableByWindowBackground = false
        panel.contentView = view
        if Self.animates { panel.alphaValue = 0 }
        panel.orderFrontRegardless()
        if Self.animates {
            NSAnimationContext.runAnimationGroup { $0.duration = 0.15; panel.animator().alphaValue = 1 }
        }
        self.panel = panel
        content = view
        timer = ScreenshotPreviewTimer(shownAt: Self.now)
        schedule()
    }

    func dismiss(animated: Bool = true) {
        closeTimer?.invalidate()
        closeTimer = nil
        guard let panel else { return }
        // A fading card's hover mustn't reach the next shot's countdown.
        content?.hoverChanged = { _ in }
        content?.dragChanged = { _ in }
        self.panel = nil
        content = nil
        shot = nil
        if animated, Self.animates {
            NSAnimationContext.runAnimationGroup({ $0.duration = 0.25; panel.animator().alphaValue = 0 }) {
                panel.orderOut(nil)
            }
        } else {
            panel.orderOut(nil)
        }
    }

    private func perform(_ action: ScreenshotPreviewView.Action) {
        guard let shot else { return }
        switch action {
        case .edit: onEdit?(shot)
        case .copy: onCopy(shot)
        case .share: onShare?(shot)
        case .pin:
            timer.togglePin(at: Self.now)
            content?.pinned = timer.isPinned
            schedule()
        case .close: dismiss()
        }
    }

    private func hover(_ inside: Bool) {
        timer.hover(inside, at: Self.now)
        schedule()
    }

    private func dragging(_ active: Bool) {
        timer.dragging(active, at: Self.now)
        schedule()
    }

    private func schedule() {
        closeTimer?.invalidate()
        closeTimer = nil
        guard let closesAt = timer.closesAt else { return }
        closeTimer = Timer.scheduledTimer(withTimeInterval: max(0, closesAt - Self.now), repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.timer.shouldClose(at: Self.now) else { return }
                self.dismiss()
            }
        }
    }
}

private final class PreviewPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// The card: the thumbnail, and on hover a bar of controls along its bottom.
final class ScreenshotPreviewView: NSView, NSDraggingSource {
    enum Action {
        case edit, copy, share, pin, close
    }

    var action: (Action) -> Void = { _ in }
    var hoverChanged: (Bool) -> Void = { _ in }
    var dragChanged: (Bool) -> Void = { _ in }

    var hasEdit = true { didSet { rebuildBar() } }
    var editEnabled = false { didSet { rebuildBar() } }
    var hasShare = false { didSet { rebuildBar() } }
    var pinned = false { didSet { rebuildBar() } }
    /// Shown while the pointer is over the card (and forced on by the self-test render).
    var showsControls = false {
        didSet { bar.isHidden = !showsControls }
    }

    private let shot: Screenshot
    private let thumbnail: NSImage
    private let thumbnailSize: CGSize
    private let bar = ControlsBar()
    private var mouseDownPoint: NSPoint?
    private var copiedUntil: Date?

    static let maxThumbnail = CGSize(width: 260, height: 170)
    static let inset: CGFloat = 6
    static let corner: CGFloat = 12

    init(shot: Screenshot) {
        self.shot = shot
        let image = NSImage(cgImage: shot.image, size: CGSize(width: shot.image.width, height: shot.image.height))
        thumbnail = image
        let aspect = CGFloat(shot.image.width) / CGFloat(max(1, shot.image.height))
        var size = Self.maxThumbnail
        if aspect > size.width / size.height { size.height = size.width / aspect } else { size.width = size.height * aspect }
        // Never too small for the controls bar.
        thumbnailSize = CGSize(width: max(200, size.width.rounded()), height: max(72, size.height.rounded()))
        super.init(frame: CGRect(origin: .zero, size: CGSize(width: thumbnailSize.width + Self.inset * 2, height: thumbnailSize.height + Self.inset * 2)))
        bar.orientation = .horizontal
        bar.spacing = 2
        bar.edgeInsets = NSEdgeInsets(top: 0, left: 6, bottom: 0, right: 6)
        bar.isHidden = true
        bar.translatesAutoresizingMaskIntoConstraints = false
        addSubview(bar)
        NSLayoutConstraint.activate([
            bar.leadingAnchor.constraint(equalTo: leadingAnchor, constant: Self.inset + 6),
            bar.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -Self.inset - 6),
            bar.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -Self.inset - 6),
            bar.heightAnchor.constraint(equalToConstant: 30),
        ])
        rebuildBar()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }
    override var fittingSize: NSSize { frame.size }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    private func rebuildBar() {
        for view in bar.arrangedSubviews { bar.removeArrangedSubview(view); view.removeFromSuperview() }
        if hasEdit {
            let edit = button("pencil", "Edit", .edit)
            edit.isEnabled = editEnabled
            if !editEnabled { edit.toolTip = "Coming next" }
            bar.addArrangedSubview(edit)
        }
        let copied = copiedUntil.map { $0 > Date() } ?? false
        bar.addArrangedSubview(button(copied ? "checkmark" : "doc.on.doc", copied ? "Copied" : "Copy", .copy))
        if hasShare { bar.addArrangedSubview(button("square.and.arrow.up", "Share", .share)) }
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        bar.addArrangedSubview(spacer)
        bar.addArrangedSubview(button(pinned ? "pin.fill" : "pin", pinned ? "Unpin" : "Pin", .pin))
        bar.addArrangedSubview(button("xmark", "Close", .close))
    }

    private func button(_ symbol: String, _ label: String, _ action: Action) -> NSButton {
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)?
            .withSymbolConfiguration(.init(pointSize: 13, weight: .semibold))
        let button = PreviewButton(image: image ?? NSImage(), target: self, action: #selector(pressed(_:)))
        button.isBordered = false
        button.contentTintColor = .white
        button.toolTip = label
        button.tag = Self.actions.firstIndex(of: action) ?? 0
        button.setAccessibilityLabel(label)
        button.widthAnchor.constraint(equalToConstant: 28).isActive = true
        button.heightAnchor.constraint(equalToConstant: 26).isActive = true
        return button
    }

    private static let actions: [Action] = [.edit, .copy, .share, .pin, .close]

    @objc private func pressed(_ sender: NSButton) {
        let action = Self.actions[sender.tag]
        if action == .copy {
            copiedUntil = Date().addingTimeInterval(1.5)
            rebuildBar()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { [weak self] in self?.rebuildBar() }
        }
        self.action(action)
    }

    // MARK: Hover

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }

    override func mouseEntered(with event: NSEvent) {
        showsControls = true
        hoverChanged(true)
    }

    override func mouseExited(with event: NSEvent) {
        showsControls = false
        hoverChanged(false)
    }

    // MARK: Drawing

    override func draw(_ dirtyRect: NSRect) {
        let card = NSBezierPath(roundedRect: bounds, xRadius: Self.corner, yRadius: Self.corner)
        NSColor(Hotsauce.raised).setFill()
        card.fill()
        NSColor(Hotsauce.ash).setStroke()
        card.lineWidth = 1
        card.stroke()
        let picture = CGRect(x: Self.inset, y: Self.inset, width: thumbnailSize.width, height: thumbnailSize.height)
        NSGraphicsContext.saveGraphicsState()
        NSBezierPath(roundedRect: picture, xRadius: Self.corner - Self.inset, yRadius: Self.corner - Self.inset).addClip()
        NSColor(Hotsauce.sunk).setFill()
        picture.fill()
        thumbnail.draw(in: fitted(in: picture), from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: [.interpolation: NSImageInterpolation.high])
        NSGraphicsContext.restoreGraphicsState()
    }

    /// The picture, whole, centred in the thumbnail's box (a very wide or tall shot letterboxes).
    private func fitted(in box: CGRect) -> CGRect {
        let scale = min(box.width / thumbnail.size.width, box.height / thumbnail.size.height)
        let size = CGSize(width: thumbnail.size.width * scale, height: thumbnail.size.height * scale)
        return CGRect(x: box.midX - size.width / 2, y: box.midY - size.height / 2, width: size.width, height: size.height)
    }

    // MARK: Drag out as a file

    override func mouseDown(with event: NSEvent) {
        mouseDownPoint = event.locationInWindow
    }

    override func mouseDragged(with event: NSEvent) {
        guard let start = mouseDownPoint else { return }
        let point = event.locationInWindow
        guard hypot(point.x - start.x, point.y - start.y) > 3 else { return }
        mouseDownPoint = nil
        let writer: NSPasteboardWriting = shot.fileURL.map { $0 as NSURL } ?? thumbnail
        let item = NSDraggingItem(pasteboardWriter: writer)
        item.setDraggingFrame(fitted(in: bounds.insetBy(dx: Self.inset, dy: Self.inset)), contents: thumbnail)
        dragChanged(true)
        beginDraggingSession(with: [item], event: event, source: self)
    }

    override func mouseUp(with event: NSEvent) {
        mouseDownPoint = nil
    }

    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
        .copy
    }

    func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
        // The pointer may have left during the drag without an exit event.
        let inside = window?.frame.contains(NSEvent.mouseLocation) ?? false
        if !inside, showsControls {
            showsControls = false
            hoverChanged(false)
        }
        dragChanged(false)
    }
}

/// Clicks the first time, even though the panel never becomes key.
private final class PreviewButton: NSButton {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// The dark strip the controls sit on, drawn (not a layer) so the self-test render shows it.
private final class ControlsBar: NSStackView {
    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.withAlphaComponent(0.55).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 8, yRadius: 8).fill()
    }
}
