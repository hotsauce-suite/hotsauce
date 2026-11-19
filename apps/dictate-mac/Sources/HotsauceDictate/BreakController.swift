import AppKit
import CoreGraphics
import DictateCore
import SwiftUI

/// Screen breaks on the Mac (docs/PLAN-breaks.md B12). The page hands over the member's settings
/// and whether it is recording; this keeps the timer, watches time away (no input, screen locked,
/// asleep) and shows the heads-up and the break over every display, above all apps, whether or not
/// the Hotsauce window is open. It holds the break while this Mac dictates or records a call.
@MainActor
final class BreakController {
    private static let defaultsKey = "breaks.settings"

    private(set) var settings: BreaksBridge.Settings
    private var schedule: BreakSchedule?
    private var timer: Timer?
    private var lastTick: Date?
    /// The page's recording or calendar meeting.
    private var pageBusy = false
    /// What the app records itself: dictation, a call.
    private var holds: Set<String> = []
    private var locked = false
    private var countedWith = ""
    private let model = BreakModel()
    private var breakPanels: [NSPanel] = []
    private var warningPanel: NSPanel?
    private var observers: [NSObjectProtocol] = []

    init() {
        let saved = UserDefaults.standard.dictionary(forKey: Self.defaultsKey)
        settings = saved.flatMap(BreaksBridge.decode) ?? BreaksBridge.Settings()
        model.skip = { [weak self] in self?.skip() }
        model.snooze = { [weak self] in self?.snooze() }
        model.startNow = { [weak self] in self?.startNow() }
    }

    func start() {
        guard timer == nil else { return }
        let t = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
        let distributed = DistributedNotificationCenter.default()
        observers.append(distributed.addObserver(forName: .init("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.locked = true }
        })
        observers.append(distributed.addObserver(forName: .init("com.apple.screenIsUnlocked"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.locked = false }
        })
        let workspace = NSWorkspace.shared.notificationCenter
        observers.append(workspace.addObserver(forName: NSWorkspace.screensDidSleepNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.locked = true }
        })
        observers.append(workspace.addObserver(forName: NSWorkspace.screensDidWakeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.locked = false }
        })
    }

    // MARK: What the page and the app say

    func received(_ message: BreaksBridge.Message) {
        switch message {
        case let .settings(next):
            guard next != settings else { return }
            settings = next
            UserDefaults.standard.set(BreaksBridge.encode(next), forKey: Self.defaultsKey)
            tick()
        case let .busy(busy):
            pageBusy = busy
        case .startNow:
            startNow()
        }
    }

    /// The app started or stopped recording something itself ("dictate", "meeting").
    func hold(_ reason: String, _ on: Bool) {
        if on { holds.insert(reason) } else { holds.remove(reason) }
    }

    // MARK: The timer

    private var idle: TimeInterval {
        if locked { return .infinity }
        // Seconds since any keyboard or mouse input anywhere on this Mac.
        let any = CGEventType(rawValue: ~0) ?? .null
        return CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: any)
    }

    private func tick() {
        let now = Date()
        // A gap between ticks means the Mac slept: that's time away too.
        let gap = lastTick.map { now.timeIntervalSince($0) - 1 } ?? 0
        lastTick = now
        guard settings.on else {
            if schedule != nil {
                schedule = nil
                countedWith = ""
                show(.counting)
            }
            return
        }
        let key = "\(settings.everyMinutes)/\(settings.lengthSeconds)"
        if schedule == nil || countedWith != key {
            schedule = .start(settings, now: now)
            countedWith = key
        }
        guard let current = schedule else { return }
        let (next, event) = current.step(
            settings, now: now, busy: pageBusy || !holds.isEmpty,
            idle: max(idle, gap),
            inHours: settings.hours?.contains(now) ?? true
        )
        schedule = next
        if event == .end, settings.chime { chime() }
        if next != current || event != nil { show(next.phase) }
        if case let .onBreak(endsAt) = next.phase { model.secondsLeft = max(0, Int(endsAt.timeIntervalSince(now).rounded(.up))) }
        if case let .warning(startsAt) = next.phase { model.warningLeft = max(0, Int(startsAt.timeIntervalSince(now).rounded(.up))) }
    }

    private func startNow() {
        guard settings.on else { return }
        schedule = .startNow(settings, now: Date())
        countedWith = "\(settings.everyMinutes)/\(settings.lengthSeconds)"
        model.secondsLeft = settings.lengthSeconds
        show(schedule?.phase ?? .counting)
    }

    private func skip() {
        schedule = .skip(settings, now: Date())
        show(.counting)
    }

    private func snooze() {
        schedule = .snoozed(now: Date())
        show(.counting)
    }

    private func chime() {
        let sound = NSSound(named: "Glass")
        sound?.volume = 0.35
        sound?.play()
    }

    // MARK: On screen

    private func show(_ phase: BreakSchedule.Phase) {
        model.animation = settings.animation
        switch phase {
        case .counting:
            hideBreak()
            hideWarning()
        case .warning:
            hideBreak()
            showWarning()
        case .onBreak:
            hideWarning()
            showBreak()
        }
    }

    private func showWarning() {
        let panel = warningPanel ?? makeWarningPanel()
        warningPanel = panel
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main
        if let visible = screen?.visibleFrame {
            let size = panel.frame.size
            panel.setFrameOrigin(NSPoint(x: visible.maxX - size.width - 16, y: visible.maxY - size.height - 12))
        }
        panel.orderFrontRegardless()
    }

    private func hideWarning() { warningPanel?.orderOut(nil) }

    private func makeWarningPanel() -> NSPanel {
        let panel = BreakPanel(
            contentRect: NSRect(x: 0, y: 0, width: 360, height: 64),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: true
        )
        configure(panel, level: .statusBar)
        panel.contentView = NSHostingView(rootView: BreakWarningView(model: model))
        return panel
    }

    private func showBreak() {
        if breakPanels.isEmpty {
            for screen in NSScreen.screens {
                let panel = BreakPanel(
                    contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel],
                    backing: .buffered, defer: false
                )
                configure(panel, level: .screenSaver)
                panel.setFrame(screen.frame, display: false)
                panel.contentView = NSHostingView(rootView: BreakView(model: model, primary: screen == NSScreen.main))
                panel.onEscape = { [weak self] in self?.skip() }
                breakPanels.append(panel)
            }
        }
        for panel in breakPanels {
            panel.alphaValue = 0
            panel.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.8
                panel.animator().alphaValue = 1
            }
        }
        // Key, so Esc skips, without bringing Hotsauce's own window forward.
        breakPanels.first { $0.screen == NSScreen.main }?.makeKey()
    }

    private func hideBreak() {
        for panel in breakPanels { panel.orderOut(nil) }
        breakPanels = []
    }

    private func configure(_ panel: NSPanel, level: NSWindow.Level) {
        panel.isFloatingPanel = true
        panel.level = level
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.isReleasedWhenClosed = false
    }
}

/// A panel that can take Esc and clicks without making Hotsauce the active app.
private final class BreakPanel: NSPanel {
    var onEscape: (() -> Void)?
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    override func cancelOperation(_ sender: Any?) { onEscape?() }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { onEscape?() } else { super.keyDown(with: event) }
    }
}

@MainActor
final class BreakModel: ObservableObject {
    @Published var animation: BreaksBridge.Animation = .breathe
    @Published var secondsLeft = 0
    @Published var warningLeft = 10
    var skip: () -> Void = {}
    var snooze: () -> Void = {}
    var startNow: () -> Void = {}
}

private func clock(_ seconds: Int) -> String {
    seconds < 60 ? "\(seconds)" : String(format: "%d:%02d", seconds / 60, seconds % 60)
}

private struct BreakWarningView: View {
    @ObservedObject var model: BreakModel

    var body: some View {
        HStack(spacing: 10) {
            BreakScene(animation: model.animation).frame(width: 32, height: 32).clipShape(Circle())
            Text("Screen break in \(model.warningLeft)s").font(.system(size: 13, weight: .medium)).monospacedDigit()
            Spacer(minLength: 4)
            Button("Start now") { model.startNow() }.buttonStyle(.borderedProminent).controlSize(.small)
            Button("5 more min") { model.snooze() }.buttonStyle(.borderless).controlSize(.small)
            Button("Skip") { model.skip() }.buttonStyle(.borderless).controlSize(.small)
        }
        .padding(.horizontal, 14)
        .frame(width: 360, height: 64)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
    }
}

private struct BreakView: View {
    @ObservedObject var model: BreakModel
    let primary: Bool

    var body: some View {
        ZStack {
            Color(red: 0.06, green: 0.08, blue: 0.14).opacity(0.86).ignoresSafeArea()
            if primary {
                VStack(spacing: 28) {
                    BreakScene(animation: model.animation)
                        .frame(width: 260, height: 260)
                        .clipShape(Circle())
                    VStack(spacing: 6) {
                        Text("Look at something far away").font(.system(size: 26, weight: .semibold))
                        Text("Let your eyes rest and your shoulders drop.").foregroundStyle(.white.opacity(0.7))
                        Text(clock(model.secondsLeft))
                            .font(.system(size: 52, weight: .semibold, design: .rounded))
                            .monospacedDigit()
                            .padding(.top, 14)
                    }
                    HStack(spacing: 12) {
                        Button("Skip") { model.skip() }.keyboardShortcut(.cancelAction)
                        Button("5 more minutes") { model.snooze() }
                    }
                    .buttonStyle(QuietButtonStyle())
                }
                .foregroundStyle(.white)
            } else {
                BreakScene(animation: model.animation).frame(width: 200, height: 200).clipShape(Circle()).opacity(0.8)
            }
        }
    }
}

private struct QuietButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 14, weight: .medium))
            .padding(.horizontal, 18)
            .padding(.vertical, 8)
            .overlay(Capsule().stroke(.white.opacity(0.3)))
            .background(Capsule().fill(.white.opacity(configuration.isPressed ? 0.15 : 0.001)))
            .foregroundStyle(.white.opacity(0.9))
    }
}

/// The three calming animations, as the page draws them (apps/web/src/breaks/BreakScene.tsx).
/// Still when the Mac is set to reduce motion.
private struct BreakScene: View {
    let animation: BreaksBridge.Animation
    private let still = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: still)) { context in
            let t = still ? 0 : context.date.timeIntervalSinceReferenceDate
            Canvas { gc, size in
                switch animation {
                case .breathe: drawBreathe(gc, size, t)
                case .clouds: drawClouds(gc, size, t)
                case .waves: drawWaves(gc, size, t)
                }
            }
        }
    }

    private func drawBreathe(_ gc: GraphicsContext, _ size: CGSize, _ t: TimeInterval) {
        // In for 4 seconds, out for 6, as breaks.css.
        let phase = t.truncatingRemainder(dividingBy: 10)
        let p = phase < 4 ? phase / 4 : 1 - (phase - 4) / 6
        let eased = 0.5 - cos(p * .pi) / 2
        let scale = still ? 0.85 : 0.55 + 0.45 * eased
        let side = min(size.width, size.height) * scale
        let rect = CGRect(x: (size.width - side) / 2, y: (size.height - side) / 2, width: side, height: side)
        let ember = Color(red: 0.91, green: 0.45, blue: 0.27)
        gc.fill(Path(ellipseIn: rect), with: .radialGradient(
            Gradient(colors: [ember.opacity(0.95), ember.opacity(0.7), ember.opacity(0)]),
            center: CGPoint(x: rect.midX, y: rect.midY - side * 0.05), startRadius: 0, endRadius: side / 2
        ))
    }

    private func drawClouds(_ gc: GraphicsContext, _ size: CGSize, _ t: TimeInterval) {
        gc.fill(Path(CGRect(origin: .zero, size: size)), with: .linearGradient(
            Gradient(colors: [Color(red: 0.50, green: 0.70, blue: 0.85), Color(red: 0.73, green: 0.84, blue: 0.92), Color(red: 0.95, green: 0.89, blue: 0.81)]),
            startPoint: .zero, endPoint: CGPoint(x: 0, y: size.height)
        ))
        var blurred = gc
        blurred.addFilter(.blur(radius: size.width * 0.02))
        for (top, w, h, period, offset) in [(0.18, 0.46, 0.16, 38.0, 6.0), (0.44, 0.34, 0.12, 52.0, 30.0), (0.64, 0.54, 0.18, 44.0, 18.0)] {
            let progress = ((t + offset).truncatingRemainder(dividingBy: period)) / period
            let width = size.width * w
            let x = -width * 0.6 + progress * (size.width + width * 1.2)
            blurred.fill(Path(ellipseIn: CGRect(x: x, y: size.height * top, width: width, height: size.height * h)), with: .color(.white.opacity(0.85)))
        }
    }

    private func drawWaves(_ gc: GraphicsContext, _ size: CGSize, _ t: TimeInterval) {
        gc.fill(Path(CGRect(origin: .zero, size: size)), with: .linearGradient(
            Gradient(colors: [Color(red: 0.17, green: 0.23, blue: 0.39), Color(red: 0.29, green: 0.42, blue: 0.56), Color(red: 0.53, green: 0.68, blue: 0.78)]),
            startPoint: .zero, endPoint: CGPoint(x: 0, y: size.height)
        ))
        for (base, alpha, period) in [(0.62, 0.10, 18.0), (0.74, 0.16, 13.0), (0.86, 0.24, 9.0)] {
            let shift = (t.truncatingRemainder(dividingBy: period)) / period * 2 * .pi
            var path = Path()
            path.move(to: CGPoint(x: 0, y: size.height))
            for step in 0...60 {
                let x = size.width * CGFloat(step) / 60
                let y = size.height * base + sin(Double(step) / 60 * 4 * .pi + shift) * size.height * 0.04
                path.addLine(to: CGPoint(x: x, y: y))
            }
            path.addLine(to: CGPoint(x: size.width, y: size.height))
            path.closeSubpath()
            gc.fill(path, with: .color(.white.opacity(alpha)))
        }
    }
}
