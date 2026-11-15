import AppKit
import ApplicationServices
import DictateCore
import QuartzCore

/// The edge glow while Dictate listens: a warm line around the window being typed into, with
/// flames along the bottom that follow the voice (docs/PLAN-dictate-edge-glow.md). The look's
/// numbers are in `EdgeGlowLook`; the phases in `EdgeGlowMachine`. Main thread only.
@MainActor
final class EdgeGlow {
    /// Reduce motion is read when each dictation starts. Overridable for `--edge-glow-demo`.
    var reduceMotion: () -> Bool = { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    private var machine = EdgeGlowMachine()
    private var level = EdgeGlowLevel()
    /// Made on the first dictation that shows a glow, then reused.
    private var panel: NSPanel?
    private var glowView: EdgeGlowView?
    private var displayLink: CADisplayLink?
    private var lastTick: CFTimeInterval?
    private var startedAt: CFTimeInterval = 0
    private var animates = true
    /// Bumped by each dictation, so a slow window lookup for an earlier one is dropped.
    private var generation = 0
    /// Bumped by each fade, so an older fade's completion can't hide a newer one early.
    private var fadeID = 0

    /// Recording has started. `pid` is the app being dictated into; its focused window is looked
    /// up off the main thread, so a slow app never holds anything up.
    func listen(pid: pid_t?) {
        guard machine.handle(.listen) == .listening else { return }
        generation += 1
        let generation = generation
        level.reset()
        animates = EdgeGlowLook.animates(reduceMotion: reduceMotion())
        DispatchQueue.global(qos: .userInteractive).async {
            let window = pid.flatMap(Self.focusedWindow)
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self.present(window: window, generation: generation) }
            }
        }
    }

    /// The level (0…1 RMS) of each block from the microphone.
    func push(level raw: Float) {
        guard machine.phase == .listening else { return }
        level.target(raw: raw)
    }

    /// The recording is being written up: the flames settle and the glow pulses gently.
    func think() {
        guard machine.handle(.think) == .thinking else { return }
        stopTicking()
        level.reset()
        // Shown yet? If not, present() pulses when the window lookup comes back.
        guard let glowView, panel?.isVisible == true else { return }
        startPulse(in: glowView)
    }

    private func startPulse(in glowView: EdgeGlowView) {
        glowView.setFlames(level: 0, time: CACurrentMediaTime() - startedAt, animates: animates)
        if animates {
            let pulse = CABasicAnimation(keyPath: "opacity")
            pulse.fromValue = EdgeGlowLook.thinkingOpacity.high
            pulse.toValue = EdgeGlowLook.thinkingOpacity.low
            pulse.duration = EdgeGlowLook.pulse
            pulse.autoreverses = true
            pulse.repeatCount = .infinity
            pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            glowView.root.add(pulse, forKey: "pulse")
        } else {
            glowView.root.opacity = EdgeGlowLook.thinkingOpacity.high
        }
    }

    /// Pasted, copied, cancelled, too short or failed: fade out.
    func finish() {
        guard machine.handle(.finish) == .fading else { return }
        stopTicking()
        guard let glowView, let panel, panel.isVisible else {
            _ = machine.handle(.faded)
            return
        }
        let root = glowView.root
        let from = root.presentation()?.opacity ?? root.opacity
        root.removeAnimation(forKey: "pulse")
        root.removeAnimation(forKey: "fadeIn")
        fadeID += 1
        let fadeID = fadeID
        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak self] in
            MainActor.assumeIsolated {
                // A newer fade owns the panel now; a dictation started during the fade keeps it.
                guard let self, fadeID == self.fadeID, self.machine.handle(.faded) == .idle else { return }
                self.panel?.orderOut(nil)
            }
        }
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = from
        fade.toValue = 0
        fade.duration = EdgeGlowLook.fadeOut
        fade.timingFunction = CAMediaTimingFunction(name: .easeIn)
        root.opacity = 0
        root.add(fade, forKey: "fadeOut")
        CATransaction.commit()
    }

    // MARK: Showing

    private func present(window: CGRect?, generation: Int) {
        // Too late: the dictation ended, or another one started, while the window was looked up.
        // A short dictation may already be writing up: show it pulsing.
        guard generation == self.generation, machine.phase == .listening || machine.phase == .thinking else { return }
        let screens = NSScreen.screens
        guard let placement = EdgeGlowGeometry.placement(window: window, screens: screens.map(\.frame), mouse: NSEvent.mouseLocation) else { return }
        let panel = panel ?? makePanel()
        guard let glowView else { return }
        panel.setFrame(placement.frame, display: false)
        // The scale of the screen it lands on: the hidden panel's own can still be the last screen's.
        let screen = screens.first { $0.frame.contains(CGPoint(x: placement.frame.midX, y: placement.frame.midY)) }
        glowView.layout(
            size: placement.frame.size,
            scale: screen?.backingScaleFactor ?? panel.backingScaleFactor,
            cornerRadius: placement.isScreen ? EdgeGlowLook.screenCornerRadius : EdgeGlowLook.windowCornerRadius,
            flames: animates
        )
        startedAt = CACurrentMediaTime()
        glowView.setFlames(level: 0, time: 0, animates: animates)
        let root = glowView.root
        root.removeAllAnimations()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        root.opacity = 1
        CATransaction.commit()
        let fadeIn = CABasicAnimation(keyPath: "opacity")
        fadeIn.fromValue = 0
        fadeIn.toValue = 1
        fadeIn.duration = EdgeGlowLook.fadeIn
        root.add(fadeIn, forKey: "fadeIn")
        // orderFrontRegardless shows it without activating the app or taking keyboard focus.
        panel.orderFrontRegardless()
        if machine.phase == .thinking {
            startPulse(in: glowView)
        } else if animates {
            startTicking(in: glowView)
        }
    }

    private func makePanel() -> NSPanel {
        let panel = GlowPanel(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.isFloatingPanel = true
        // Above normal windows and full-screen apps, below the pill (.statusBar), so its text stays readable.
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue - 1)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.animationBehavior = .none
        let view = EdgeGlowView(frame: panel.contentRect(forFrameRect: panel.frame))
        panel.contentView = view
        self.panel = panel
        glowView = view
        return panel
    }

    // MARK: Frames

    private func startTicking(in view: NSView) {
        stopTicking()
        let link = view.displayLink(target: self, selector: #selector(tick(_:)))
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    private func stopTicking() {
        displayLink?.invalidate()
        displayLink = nil
        lastTick = nil
    }

    @objc private func tick(_ link: CADisplayLink) {
        let now = link.timestamp
        let dt = lastTick.map { now - $0 } ?? link.duration
        lastTick = now
        level.step(dt: dt)
        glowView?.setFlames(level: level.value, time: now - startedAt, animates: true)
    }

    // MARK: The focused window

    /// The app's focused window, in Cocoa screen coordinates, or nil (no Accessibility permission,
    /// no window, or the app didn't answer within a quarter second).
    nonisolated static func focusedWindow(pid: pid_t) -> CGRect? {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.25)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &value) == .success,
              let value, CFGetTypeID(value) == AXUIElementGetTypeID()
        else { return nil }
        let window = value as! AXUIElement
        AXUIElementSetMessagingTimeout(window, 0.25)
        guard let position = point(window, kAXPositionAttribute), let size = size(window, kAXSizeAttribute) else { return nil }
        // The Accessibility API measures from the top of the main display (the one with the menu bar).
        let primary = CGDisplayBounds(CGMainDisplayID()).height
        guard primary > 0 else { return nil }
        return EdgeGlowGeometry.cocoaFrame(axPosition: position, axSize: size, primaryScreenHeight: primary)
    }

    private nonisolated static func point(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let value, CFGetTypeID(value) == AXValueGetTypeID()
        else { return nil }
        var point = CGPoint.zero
        return AXValueGetValue(value as! AXValue, .cgPoint, &point) ? point : nil
    }

    private nonisolated static func size(_ element: AXUIElement, _ attribute: String) -> CGSize? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let value, CFGetTypeID(value) == AXValueGetTypeID()
        else { return nil }
        var size = CGSize.zero
        return AXValueGetValue(value as! AXValue, .cgSize, &size) ? size : nil
    }
}

/// Never key or main, so showing it can't take focus from the app being typed in.
private final class GlowPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// The layers: a rounded clip holding four soft edge washes, two flame bands masked by wavy
/// paths, and the bright line with its glow on top. Only the two mask paths change per frame.
private final class EdgeGlowView: NSView {
    let root = CALayer()
    private let washes = (0..<4).map { _ in CAGradientLayer() }
    private let backFlame = CAGradientLayer()
    private let frontFlame = CAGradientLayer()
    private let backMask = CAShapeLayer()
    private let frontMask = CAShapeLayer()
    private let line = CAShapeLayer()
    private var size = CGSize.zero

    override init(frame: NSRect) {
        super.init(frame: frame)
        // Layer-hosting: the view never draws, Core Animation composites the layers.
        layer = CALayer()
        wantsLayer = true
        layer?.addSublayer(root)
        root.masksToBounds = true
        for wash in washes { root.addSublayer(wash) }
        root.addSublayer(backFlame)
        root.addSublayer(frontFlame)
        root.addSublayer(line)
        backFlame.mask = backMask
        frontFlame.mask = frontMask

        let amber = EdgeGlowLook.line
        for wash in washes {
            wash.colors = [cg(amber, 0.30), cg(amber, 0)]
        }
        // See-through, like a haze: the window's text stays readable under the flames.
        backFlame.colors = [cg(EdgeGlowLook.flameMiddle, 0.55), cg(EdgeGlowLook.flameTip, 0.22), cg(EdgeGlowLook.flameTip, 0)]
        backFlame.locations = [0, 0.4, 0.9]
        frontFlame.colors = [cg(EdgeGlowLook.flameBase, 0.85), cg(EdgeGlowLook.flameMiddle, 0.35), cg(EdgeGlowLook.flameMiddle, 0)]
        frontFlame.locations = [0, 0.3, 0.85]
        for flame in [backFlame, frontFlame] {
            // Gradient points are in the layer's unit square, y up: bottom to top.
            flame.startPoint = CGPoint(x: 0.5, y: 0)
            flame.endPoint = CGPoint(x: 0.5, y: 1)
        }
        line.fillColor = nil
        line.strokeColor = cg(amber, 0.95)
        line.lineWidth = EdgeGlowLook.lineWidth
        line.shadowColor = cg(EdgeGlowLook.flameMiddle, 1)
        line.shadowOpacity = 0.9
        line.shadowRadius = EdgeGlowLook.lineGlowRadius
        line.shadowOffset = .zero
        // The line's blurred glow never changes while shown: draw it once.
        line.shouldRasterize = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    func layout(size: CGSize, scale: CGFloat, cornerRadius: CGFloat, flames: Bool) {
        self.size = size
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let bounds = CGRect(origin: .zero, size: size)
        for layer in [root, line, backFlame, frontFlame, backMask, frontMask] + washes {
            layer.contentsScale = scale
        }
        line.rasterizationScale = scale
        root.frame = bounds
        root.cornerRadius = cornerRadius
        let inset = EdgeGlowLook.lineWidth / 2
        line.frame = bounds
        line.path = CGPath(
            roundedRect: bounds.insetBy(dx: inset, dy: inset),
            cornerWidth: max(0, cornerRadius - inset),
            cornerHeight: max(0, cornerRadius - inset),
            transform: nil
        )

        // Washes: bottom, top, left, right, each fading inward. Without flames the bottom one is
        // deeper, so the bottom still reads as the warm edge.
        let w = EdgeGlowLook.innerWash
        let bottom = flames ? w : w * 2
        let frames = [
            CGRect(x: 0, y: 0, width: size.width, height: bottom),
            CGRect(x: 0, y: size.height - w, width: size.width, height: w),
            CGRect(x: 0, y: 0, width: w, height: size.height),
            CGRect(x: size.width - w, y: 0, width: w, height: size.height),
        ]
        let directions: [(CGPoint, CGPoint)] = [
            (CGPoint(x: 0.5, y: 0), CGPoint(x: 0.5, y: 1)),
            (CGPoint(x: 0.5, y: 1), CGPoint(x: 0.5, y: 0)),
            (CGPoint(x: 0, y: 0.5), CGPoint(x: 1, y: 0.5)),
            (CGPoint(x: 1, y: 0.5), CGPoint(x: 0, y: 0.5)),
        ]
        washes[0].colors = [cg(EdgeGlowLook.line, flames ? 0.30 : 0.6), cg(EdgeGlowLook.line, 0)]
        for (index, wash) in washes.enumerated() {
            wash.frame = frames[index]
            wash.startPoint = directions[index].0
            wash.endPoint = directions[index].1
        }

        // Flames: sized each frame by setFlames, so their gradients fade out right at the tips.
        for flame in [backFlame, frontFlame] { flame.isHidden = !flames }
        CATransaction.commit()
    }

    /// Redraws the flames' wavy tops for `level` (0…1) at `time` seconds into the dictation.
    func setFlames(level: Float, time: CFTimeInterval, animates: Bool) {
        guard animates, size.width > 0 else { return }
        let height = EdgeGlowLook.flameHeight(level: level, windowHeight: size.height)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for (flame, mask, share, speed, seed) in [(backFlame, backMask, 1.25, 1.0, 0.0), (frontFlame, frontMask, 0.8, 1.3, 1.0)] {
            let bandHeight = height * CGFloat(share)
            flame.frame = CGRect(x: 0, y: 0, width: size.width, height: bandHeight)
            mask.frame = flame.bounds
            mask.path = Self.flamePath(width: size.width, height: bandHeight, time: time * speed, seed: seed)
        }
        backFlame.opacity = 0.75 + 0.25 * level
        frontFlame.opacity = 0.8 + 0.2 * level
        CATransaction.commit()
    }

    /// A band from the bottom edge up to a wavy top: drifting sine waves, sharpened so the crests
    /// read as tongues of flame, never lower than a third of the height so the band stays whole.
    private static func flamePath(width: CGFloat, height: CGFloat, time: CFTimeInterval, seed: Double) -> CGPath {
        let path = CGMutablePath()
        path.move(to: .zero)
        // About 320 points across, however wide, so a 5K screen costs no more per frame.
        let step = max(6, width / 320)
        var x: CGFloat = 0
        let t = time + seed * 7.3
        while x <= width + step {
            let px = Double(x)
            let wave = 0.4 * sin(px * 0.013 + t * 1.9 + seed)
                + 0.35 * sin(px * 0.037 - t * 3.1 + 1.3 + seed * 2)
                + 0.25 * sin(px * 0.081 + t * 5.2 + 2.1 + seed * 3)
            let crest = pow((wave + 1) / 2, 2.2)
            let y = height * (0.33 + 0.67 * CGFloat(crest))
            path.addLine(to: CGPoint(x: min(x, width), y: y))
            x += step
        }
        path.addLine(to: CGPoint(x: width, y: 0))
        path.closeSubpath()
        return path
    }

    private func cg(_ rgb: EdgeGlowLook.RGB, _ alpha: CGFloat) -> CGColor {
        CGColor(srgbRed: rgb.red, green: rgb.green, blue: rgb.blue, alpha: alpha)
    }
}

/// `HearthDictate --edge-glow-demo [seconds] [--reduce-motion]`: shows the glow around the
/// frontmost window with a made-up voice for a few seconds, then the write-up pulse and the fade,
/// for checking the look without a microphone, a server or a sound.
@MainActor
enum EdgeGlowDemo {
    static func run(arguments: [String]) -> Int32 {
        let seconds = arguments.firstIndex(of: "--edge-glow-demo")
            .flatMap { arguments.indices.contains($0 + 1) ? Double(arguments[$0 + 1]) : nil } ?? 6
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        app.finishLaunching()
        let glow = EdgeGlow()
        if arguments.contains("--reduce-motion") { glow.reduceMotion = { true } }
        glow.listen(pid: NSWorkspace.shared.frontmostApplication?.processIdentifier)
        let start = Date()
        func wait(_ interval: TimeInterval) { RunLoop.main.run(until: Date().addingTimeInterval(interval)) }
        while Date().timeIntervalSince(start) < seconds {
            let t = Date().timeIntervalSince(start)
            // About four syllables a second, in phrases with short pauses between them.
            let syllable = max(0, sin(t * 2 * .pi * 3.7))
            let phrase = sin(t * 2 * .pi * 0.3) > -0.4 ? 1.0 : 0.03
            glow.push(level: Float(0.002 + 0.12 * syllable * phrase))
            wait(0.04)
        }
        glow.think()
        wait(1.6)
        glow.finish()
        wait(0.6)
        return 0
    }
}

/// `HearthDictate --render-edge-glow <folder>`: draws the glow over a stand-in window to PNGs
/// (loud, quiet, writing up, reduce motion), for checking the look without screen access.
@MainActor
enum EdgeGlowPreview {
    static func render(to folder: String) -> Int32 {
        let size = CGSize(width: 900, height: 560)
        let scale: CGFloat = 2
        let states: [(name: String, level: Float, flames: Bool)] = [
            ("edge-glow-loud", 0.85, true),
            ("edge-glow-quiet", 0.15, true),
            ("edge-glow-writing-up", 0, true),
            ("edge-glow-reduce-motion", 0, false),
        ]
        for state in states {
            let view = EdgeGlowView(frame: CGRect(origin: .zero, size: size))
            view.layout(size: size, scale: scale, cornerRadius: EdgeGlowLook.windowCornerRadius, flames: state.flames)
            view.setFlames(level: state.level, time: 1.7, animates: state.flames)
            if state.name == "edge-glow-writing-up" { view.root.opacity = EdgeGlowLook.thinkingOpacity.high }
            guard let context = CGContext(
                data: nil, width: Int(size.width * scale), height: Int(size.height * scale), bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return 1 }
            context.scaleBy(x: scale, y: scale)
            drawStandInWindow(in: context, size: size)
            view.root.render(in: context)
            guard let image = context.makeImage() else { return 1 }
            let url = URL(fileURLWithPath: folder).appendingPathComponent("\(state.name).png")
            guard let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { return 1 }
            try? data.write(to: url)
        }
        return 0
    }

    /// A dark editor-like window: a title bar and some lines of text.
    private static func drawStandInWindow(in context: CGContext, size: CGSize) {
        let bounds = CGRect(origin: .zero, size: size)
        context.addPath(CGPath(roundedRect: bounds, cornerWidth: EdgeGlowLook.windowCornerRadius, cornerHeight: EdgeGlowLook.windowCornerRadius, transform: nil))
        context.setFillColor(CGColor(srgbRed: 0.12, green: 0.11, blue: 0.11, alpha: 1))
        context.fillPath()
        context.setFillColor(CGColor(srgbRed: 0.17, green: 0.16, blue: 0.15, alpha: 1))
        context.fill(CGRect(x: 0, y: size.height - 40, width: size.width, height: 40))
        for (index, color) in [(1.0, 0.37, 0.34), (1.0, 0.74, 0.18), (0.16, 0.79, 0.25)].enumerated() {
            context.setFillColor(CGColor(srgbRed: color.0, green: color.1, blue: color.2, alpha: 1))
            context.fillEllipse(in: CGRect(x: 18 + CGFloat(index) * 20, y: size.height - 26, width: 12, height: 12))
        }
        context.setFillColor(CGColor(srgbRed: 0.85, green: 0.82, blue: 0.78, alpha: 0.35))
        for row in 0..<11 {
            let width = [620, 540, 700, 300, 0, 660, 580, 420, 640, 0, 380][row]
            context.fill(CGRect(x: 48, y: size.height - 90 - CGFloat(row) * 30, width: CGFloat(width), height: 10))
        }
    }
}
