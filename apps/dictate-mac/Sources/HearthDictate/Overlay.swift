import AppKit
import SwiftUI

/// What the pill at the bottom of the screen shows.
final class OverlayModel: ObservableObject {
    enum Phase: Equatable {
        case recording
        case processing
        case message(String)
    }

    @Published var phase: Phase = .recording
    /// Recent levels, oldest first, for the meter.
    @Published var levels: [Float] = Array(repeating: 0, count: 18)

    func push(level: Float) {
        // Speech sits low on a linear scale; a square root spreads it across the bars.
        levels.removeFirst()
        levels.append(min(1, level.squareRoot() * 2.2))
    }
}

/// A panel that is never key or main, so showing it can't take focus from the app being typed in.
private final class NonActivatingPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// The floating pill: live level while recording, a spinner while Hearth works, a short message.
final class Overlay {
    let model = OverlayModel()
    private let panel: NSPanel
    private var hideWork: DispatchWorkItem?

    init() {
        panel = NonActivatingPanel(
            contentRect: NSRect(x: 0, y: 0, width: 260, height: 44),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: true
        )
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.contentView = NSHostingView(rootView: OverlayView(model: model))
    }

    func showRecording() {
        model.levels = Array(repeating: 0, count: model.levels.count)
        show(.recording, hideAfter: nil)
    }

    func showProcessing() { show(.processing, hideAfter: nil) }

    func showMessage(_ text: String, seconds: TimeInterval = 2.5) { show(.message(text), hideAfter: seconds) }

    func hide() {
        hideWork?.cancel()
        panel.orderOut(nil)
    }

    private func show(_ phase: OverlayModel.Phase, hideAfter seconds: TimeInterval?) {
        hideWork?.cancel()
        model.phase = phase
        position()
        // orderFrontRegardless shows it without activating Hearth Dictate.
        panel.orderFrontRegardless()
        if let seconds {
            let work = DispatchWorkItem { [weak self] in self?.panel.orderOut(nil) }
            hideWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
        }
    }

    /// Bottom centre of the screen the pointer is on.
    private func position() {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main
        guard let visible = screen?.visibleFrame else { return }
        let size = panel.frame.size
        panel.setFrameOrigin(NSPoint(x: visible.midX - size.width / 2, y: visible.minY + 56))
    }
}

private struct OverlayView: View {
    @ObservedObject var model: OverlayModel

    var body: some View {
        HStack(spacing: 10) {
            switch model.phase {
            case .recording:
                Circle().fill(Color(red: 1, green: 0.42, blue: 0.24)).frame(width: 8, height: 8)
                HStack(alignment: .center, spacing: 3) {
                    ForEach(Array(model.levels.enumerated()), id: \.offset) { _, level in
                        Capsule()
                            .fill(Color(red: 0.93, green: 0.6, blue: 0.27))
                            .frame(width: 3, height: 4 + CGFloat(level) * 18)
                    }
                }
                .animation(.easeOut(duration: 0.08), value: model.levels)
            case .processing:
                ProgressView().controlSize(.small).colorScheme(.dark)
                Text("Writing it up…").font(.system(size: 12, weight: .medium)).foregroundStyle(.white.opacity(0.85))
            case let .message(text):
                Text(text).font(.system(size: 12, weight: .medium)).foregroundStyle(.white.opacity(0.92)).lineLimit(1)
            }
        }
        .padding(.horizontal, 16)
        .frame(height: 36)
        .background(Capsule().fill(Color(red: 0.16, green: 0.13, blue: 0.11).opacity(0.94)))
        .overlay(Capsule().strokeBorder(Color.white.opacity(0.08)))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
