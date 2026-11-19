import AppKit
import DictateCore
import UniformTypeIdentifiers
import Vision

/// One screenshot's editor window (docs/PLAN-screenshots.md slice 3): a toolbar of tools, colours
/// and widths over the canvas, with Copy, Copy Text and Save. Closing it with changes saves the
/// flattened picture over the shot's file; the layers stay editable for the recent captures.
@MainActor
final class ScreenshotEditor: NSObject, NSWindowDelegate {
    private(set) var shot: Screenshot
    let canvas: EditorCanvas
    let window: NSWindow
    /// Slice 4 shares the flattened picture; until then the button is hidden.
    var onShare: ((Data) -> Void)? { didSet { shareButton.isHidden = onShare == nil } }
    /// Closed: hands back the document (and the shot, with its file) to keep for next time.
    var onClose: (Screenshot, ShotDocument) -> Void = { _, _ in }
    var showError: (String) -> Void = { _ in }

    /// What the file on disk holds, so closing knows whether there is anything to save.
    private var savedDocument: ShotDocument
    private var toolButtons: [ShotTool: NSButton] = [:]
    private var swatches: [SwatchButton] = []
    private let widths = NSSegmentedControl()
    private let redactStyle = NSSegmentedControl()
    private let shareButton = NSButton()
    private let status = NSTextField(labelWithString: "")
    private var statusWork: DispatchWorkItem?

    init(shot: Screenshot, document: ShotDocument?) {
        self.shot = shot
        let document = document ?? ShotDocument(sourceWidth: shot.image.width, sourceHeight: shot.image.height)
        savedDocument = document
        canvas = EditorCanvas(source: shot.image, document: document)
        window = NSWindow(
            contentRect: Self.initialFrame(for: shot.image),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        super.init()
        window.title = shot.fileURL?.deletingPathExtension().lastPathComponent ?? "Screenshot"
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 980, height: 480)
        window.delegate = self
        window.contentView = makeContent()
        window.center()
        canvas.onCopy = { [weak self] in self?.copyPicture() }
        canvas.onSave = { [weak self] saveAs in self?.save(as: saveAs) }
        canvas.onToolChange = { [weak self] in self?.refreshControls() }
        canvas.onSelectionChange = { [weak self] in self?.refreshControls() }
        canvas.onChange = { [weak self] in self?.refreshControls() }
        refreshControls()
    }

    func show() {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(canvas)
    }

    /// The picture at most 80% of the screen, at no more than actual size.
    private static func initialFrame(for image: CGImage) -> NSRect {
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let scale = NSScreen.main?.backingScaleFactor ?? 2
        let picture = CGSize(width: CGFloat(image.width) / scale, height: CGFloat(image.height) / scale)
        let width = min(max(screen.width * 0.8, 980), max(1000, picture.width + 48))
        let height = min(screen.height * 0.8, max(480, picture.height + 48 + EditorToolbar.height))
        return NSRect(x: 0, y: 0, width: width, height: height)
    }

    // MARK: Layout

    private func makeContent() -> NSView {
        let root = NSView()
        let bar = EditorToolbar()
        bar.translatesAutoresizingMaskIntoConstraints = false
        canvas.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(canvas)
        root.addSubview(bar)
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: root.topAnchor),
            bar.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            bar.heightAnchor.constraint(equalToConstant: EditorToolbar.height),
            canvas.topAnchor.constraint(equalTo: bar.bottomAnchor),
            canvas.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            canvas.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            canvas.bottomAnchor.constraint(equalTo: root.bottomAnchor),
        ])

        let tools = NSStackView()
        tools.spacing = 2
        for tool in ShotTool.allCases {
            let button = ToolButton(symbol: Self.symbol(for: tool), label: tool.tooltip, target: self, action: #selector(pickTool(_:)))
            button.tag = ShotTool.allCases.firstIndex(of: tool)!
            toolButtons[tool] = button
            tools.addArrangedSubview(button)
        }

        let colors = NSStackView()
        colors.spacing = 4
        for (index, entry) in ShotPalette.colors.enumerated() {
            let swatch = SwatchButton(color: entry.color, name: entry.name, target: self, action: #selector(pickColor(_:)))
            swatch.tag = index
            swatches.append(swatch)
            colors.addArrangedSubview(swatch)
        }

        widths.segmentCount = ShotPalette.widths.count
        for (index, width) in ShotPalette.widths.enumerated() {
            widths.setImage(Self.lineImage(width: width), forSegment: index)
            widths.setWidth(30, forSegment: index)
            widths.setToolTip(["Thin", "Medium", "Thick"][index], forSegment: index)
        }
        widths.trackingMode = .selectOne
        widths.target = self
        widths.action = #selector(pickWidth(_:))
        widths.setAccessibilityLabel("Line width")
        widths.controlSize = .small

        redactStyle.segmentCount = 2
        redactStyle.setLabel("Block", forSegment: 0)
        redactStyle.setLabel("Pixelate", forSegment: 1)
        redactStyle.setToolTip("Covers it with solid colour", forSegment: 0)
        redactStyle.setToolTip("Covers it with coarse blocks of its average colours", forSegment: 1)
        redactStyle.trackingMode = .selectOne
        redactStyle.selectedSegment = 0
        redactStyle.target = self
        redactStyle.action = #selector(pickRedactStyle(_:))
        redactStyle.controlSize = .small
        redactStyle.setAccessibilityLabel("Redaction style")

        status.font = .systemFont(ofSize: 12, weight: .medium)
        status.textColor = .secondaryLabelColor
        status.lineBreakMode = .byTruncatingTail
        status.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let copyText = actionButton("Copy Text", "text.viewfinder", #selector(copyText), tooltip: "Copy the text in this picture")
        let copy = actionButton("Copy", "doc.on.doc", #selector(copyPressed), tooltip: "Copy the picture (⌘C)")
        let save = actionButton("Save", "square.and.arrow.down", #selector(savePressed), tooltip: "Save over the screenshot (⌘S); ⇧⌘S saves a copy")
        shareButton.title = "Share"
        shareButton.image = NSImage(systemSymbolName: "square.and.arrow.up", accessibilityDescription: "Share")
        shareButton.imagePosition = .imageLeading
        shareButton.bezelStyle = .rounded
        shareButton.controlSize = .small
        shareButton.target = self
        shareButton.action = #selector(sharePressed)
        shareButton.isHidden = true

        let spacer = NSView()
        spacer.setContentHuggingPriority(.init(1), for: .horizontal)
        let row = NSStackView(views: [tools, divider(), colors, widths, redactStyle, spacer, status, copyText, copy, save, shareButton])
        row.spacing = 10
        row.edgeInsets = NSEdgeInsets(top: 0, left: 12, bottom: 0, right: 12)
        row.translatesAutoresizingMaskIntoConstraints = false
        bar.addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: bar.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: bar.trailingAnchor),
            row.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
        ])
        return root
    }

    private func divider() -> NSView {
        let line = NSBox()
        line.boxType = .separator
        line.widthAnchor.constraint(equalToConstant: 1).isActive = true
        line.heightAnchor.constraint(equalToConstant: 22).isActive = true
        return line
    }

    private func actionButton(_ title: String, _ symbol: String, _ action: Selector, tooltip: String) -> NSButton {
        let button = NSButton(title: title, image: NSImage(systemSymbolName: symbol, accessibilityDescription: title) ?? NSImage(), target: self, action: action)
        button.imagePosition = .imageLeading
        button.bezelStyle = .rounded
        button.controlSize = .small
        button.toolTip = tooltip
        return button
    }

    static func symbol(for tool: ShotTool) -> String {
        switch tool {
        case .select: "cursorarrow"
        case .arrow: "arrow.up.right"
        case .rectangle: "rectangle"
        case .ellipse: "circle"
        case .text: "textformat"
        case .highlighter: "highlighter"
        case .step: "1.circle"
        case .redact: "rectangle.inset.filled"
        case .crop: "crop"
        }
    }

    /// A short line of the given thickness, for the width control.
    private static func lineImage(width: CGFloat) -> NSImage {
        NSImage(size: NSSize(width: 18, height: 12), flipped: false) { rect in
            NSColor.labelColor.setFill()
            let height = max(1, width / 2.5)
            NSBezierPath(roundedRect: NSRect(x: 1, y: rect.midY - height / 2, width: 16, height: height), xRadius: height / 2, yRadius: height / 2).fill()
            return true
        }.with { $0.isTemplate = true }
    }

    func refreshControls() {
        for (tool, button) in toolButtons { button.state = canvas.tool == tool ? .on : .off }
        let selected = canvas.selection.compactMap { canvas.document.layer($0) }
        let shownColor = selected.count == 1 ? selected[0].color : canvas.color
        for swatch in swatches { swatch.isChosen = swatch.color == shownColor }
        let shownWidth = selected.count == 1 ? selected[0].width : canvas.width
        widths.selectedSegment = ShotPalette.widths.firstIndex(of: shownWidth) ?? 1
        redactStyle.isHidden = !(canvas.tool == .redact || canvas.selectedRedactions)
        let edited = canvas.document != savedDocument
        window.isDocumentEdited = edited
    }

    // MARK: Actions

    @objc private func pickTool(_ sender: NSButton) {
        canvas.tool = ShotTool.allCases[sender.tag]
        window.makeFirstResponder(canvas)
    }

    @objc private func pickColor(_ sender: NSButton) {
        canvas.applyColor(ShotPalette.colors[sender.tag].color)
        refreshControls()
    }

    @objc private func pickWidth(_ sender: NSSegmentedControl) {
        canvas.applyWidth(ShotPalette.widths[max(0, sender.selectedSegment)])
        refreshControls()
    }

    @objc private func pickRedactStyle(_ sender: NSSegmentedControl) {
        canvas.applyRedactStyle(sender.selectedSegment == 1 ? .mosaic : .fill)
    }

    @objc private func copyPressed() { copyPicture() }
    @objc private func savePressed() { save(as: false) }

    @objc private func sharePressed() {
        canvas.commitText()
        guard let png = flattened() else { return }
        onShare?(png)
    }

    /// The flattened, redacted picture: the only thing that leaves the editor.
    func flattened() -> Data? {
        ShotRenderer.exportPNG(canvas.document, source: shot.image, pixels: canvas.pixels)
    }

    func copyPicture() {
        canvas.commitText()
        guard let png = flattened(), let image = NSBitmapImageRep(data: png) else { return }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.declareTypes([.png, .tiff], owner: nil)
        pasteboard.setData(png, forType: .png)
        if let tiff = image.tiffRepresentation { pasteboard.setData(tiff, forType: .tiff) }
        flash("Copied")
    }

    /// ⌘S writes over the shot's file in the screenshots folder; ⇧⌘S (or no file yet) asks where.
    func save(as asking: Bool) {
        canvas.commitText()
        guard let png = flattened() else { return }
        if !asking, let url = shot.fileURL {
            write(png, to: url)
            return
        }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.png]
        panel.nameFieldStringValue = shot.fileURL?.lastPathComponent ?? ScreenshotFiles.fileName(for: shot.takenAt) { _ in false }
        panel.directoryURL = shot.fileURL?.deletingLastPathComponent()
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let url = panel.url, let self else { return }
            self.write(png, to: url)
            if self.shot.fileURL == nil { self.shot.fileURL = url }
        }
    }

    private func write(_ png: Data, to url: URL) {
        do {
            try png.write(to: url, options: .atomic)
            if url == shot.fileURL { savedDocument = canvas.document }
            refreshControls()
            flash("Saved")
        } catch {
            showError("Couldn’t save to \(url.deletingLastPathComponent().lastPathComponent)")
        }
    }

    /// Copy Text (R13): Vision reads the crop of the untouched capture, off the main thread.
    @objc func copyText() {
        let visible = canvas.document.visibleRect
        guard let image = shot.image.cropping(to: visible) else { return }
        flash("Reading…", hold: true)
        Task.detached(priority: .userInitiated) {
            let text = TextRecognition.read(image)
            await MainActor.run { [weak self] in
                guard let self else { return }
                let words = TextReadingOrder.wordCount(text)
                guard words > 0 else { self.flash("No text found"); return }
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
                self.flash("Copied \(words) \(words == 1 ? "word" : "words")")
            }
        }
    }

    private func flash(_ message: String, hold: Bool = false) {
        statusWork?.cancel()
        status.stringValue = message
        status.alphaValue = 1
        guard !hold else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
                self.status.stringValue = ""
            } else {
                NSAnimationContext.runAnimationGroup { $0.duration = 0.3; self.status.animator().alphaValue = 0 }
            }
        }
        statusWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5, execute: work)
    }

    // MARK: Closing

    /// Unsaved changes are saved over the shot's file as the window closes.
    func windowWillClose(_ notification: Notification) {
        canvas.commitText()
        if canvas.document != savedDocument, let url = shot.fileURL, let png = flattened() {
            do {
                try png.write(to: url, options: .atomic)
                savedDocument = canvas.document
            } catch {
                showError("Couldn’t save your changes to \(url.lastPathComponent)")
            }
        }
        onClose(shot, canvas.document)
    }
}

/// Vision's text, in reading order.
enum TextRecognition {
    nonisolated static func read(_ image: CGImage) -> String {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        do {
            try VNImageRequestHandler(cgImage: image).perform([request])
        } catch {
            return ""
        }
        let pieces = (request.results ?? []).compactMap { observation -> TextReadingOrder.Piece? in
            guard let text = observation.topCandidates(1).first?.string else { return nil }
            let box = observation.boundingBox
            // Vision's boxes start bottom-left; reading order wants top-left.
            return TextReadingOrder.Piece(text: text, box: CGRect(x: box.minX, y: 1 - box.maxY, width: box.width, height: box.height))
        }
        return TextReadingOrder.text(pieces)
    }
}

/// The strip above the canvas.
final class EditorToolbar: NSView {
    static let height: CGFloat = 48

    override func draw(_ dirtyRect: NSRect) {
        NSColor(Hotsauce.raised).setFill()
        bounds.fill()
        NSColor(Hotsauce.ash).setFill()
        NSRect(x: 0, y: 0, width: bounds.width, height: 1).fill()
    }
}

/// A tool: a symbol that shows as chosen.
private final class ToolButton: NSButton {
    convenience init(symbol: String, label: String, target: AnyObject, action: Selector) {
        self.init(frame: .zero)
        image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)?
            .withSymbolConfiguration(.init(pointSize: 14, weight: .medium))
        setButtonType(.pushOnPushOff)
        bezelStyle = .texturedRounded
        isBordered = true
        imagePosition = .imageOnly
        toolTip = label
        setAccessibilityLabel(label)
        self.target = target
        self.action = action
        widthAnchor.constraint(equalToConstant: 32).isActive = true
    }
}

/// A round colour swatch, ringed when chosen.
final class SwatchButton: NSButton {
    let color: ShotColor
    var isChosen = false { didSet { needsDisplay = true } }

    init(color: ShotColor, name: String, target: AnyObject, action: Selector) {
        self.color = color
        super.init(frame: NSRect(x: 0, y: 0, width: 20, height: 20))
        self.target = target
        self.action = action
        isBordered = false
        title = ""
        toolTip = name
        setAccessibilityLabel(name)
        widthAnchor.constraint(equalToConstant: 20).isActive = true
        heightAnchor.constraint(equalToConstant: 20).isActive = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func draw(_ dirtyRect: NSRect) {
        let dot = bounds.insetBy(dx: 3, dy: 3)
        NSColor(cgColor: color.cgColor)?.setFill()
        NSBezierPath(ovalIn: dot).fill()
        NSColor.labelColor.withAlphaComponent(0.3).setStroke()
        NSBezierPath(ovalIn: dot.insetBy(dx: 0.5, dy: 0.5)).stroke()
        if isChosen {
            let ring = NSBezierPath(ovalIn: bounds.insetBy(dx: 0.75, dy: 0.75))
            ring.lineWidth = 1.5
            NSColor.labelColor.setStroke()
            ring.stroke()
        }
    }
}

private extension NSImage {
    func with(_ change: (NSImage) -> Void) -> NSImage {
        change(self)
        return self
    }
}
