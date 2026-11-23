import AppKit
import DictateCore
import SwiftUI

/// "Meeting detected" (docs/PLAN-granola-calls.md): a small card at the top right of the screen
/// when a call starts, with one button. Take notes opens the meeting, which starts listening to
/// the mic and the Mac's sound at once. It never takes focus from the call, and it leaves by
/// itself after a while or when the call ends. Nothing records until the button is pressed.
@MainActor
final class CallOffer {
    final class Model: ObservableObject {
        @Published var title = "Meeting detected"
        @Published var app = ""
    }

    private let model = Model()
    private let panel: NSPanel
    private var hideWork: DispatchWorkItem?
    private var takeNotes: () -> Void = {}
    /// How long the card stays when nobody touches it.
    static let showFor: TimeInterval = 90

    /// Whether the card is on screen (for the probe and tests).
    var isShowing: Bool { panel.isVisible }

    init() {
        panel = OfferPanel(
            contentRect: NSRect(x: 0, y: 0, width: 356, height: 80),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: true
        )
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isMovableByWindowBackground = false
        let view = CallOfferView(
            model: model,
            takeNotes: { [weak self] in
                guard let self else { return }
                self.hide()
                self.takeNotes()
            },
            dismiss: { [weak self] in self?.hide() }
        )
        panel.contentView = NSHostingView(rootView: view)
    }

    /// Shows the card for a call in `app`; `takeNotes` runs when its button is pressed.
    func show(title: String, app: String, takeNotes: @escaping () -> Void) {
        hideWork?.cancel()
        model.title = title
        model.app = app
        self.takeNotes = takeNotes
        position()
        panel.orderFrontRegardless()
        let work = DispatchWorkItem { [weak self] in self?.hide() }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.showFor, execute: work)
    }

    func hide() {
        hideWork?.cancel()
        hideWork = nil
        takeNotes = {}
        panel.orderOut(nil)
    }

    /// Top right of the screen the pointer is on, under the menu bar.
    private func position() {
        let mouse = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(mouse) } ?? NSScreen.main
        guard let visible = screen?.visibleFrame else { return }
        let size = panel.frame.size
        panel.setFrameOrigin(NSPoint(x: visible.maxX - size.width - 4, y: visible.maxY - size.height - 2))
    }
}

/// Never key or main, so the card can't take focus from the call; its buttons still click.
private final class OfferPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private struct CallOfferView: View {
    @ObservedObject var model: CallOffer.Model
    let takeNotes: () -> Void
    let dismiss: () -> Void
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(model.title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                Text(model.app)
                    .font(.system(size: 12))
                    .foregroundStyle(.white.opacity(0.6))
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            Button(action: takeNotes) {
                HStack(spacing: 7) {
                    Image(nsImage: ProductMark.menuBarImage())
                        .renderingMode(.template)
                        .resizable()
                        .frame(width: 13, height: 15)
                    Text("Take notes").font(.system(size: 13, weight: .semibold))
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 12)
                .frame(height: 32)
                .background(RoundedRectangle(cornerRadius: 9).fill(Color(red: 0.78, green: 0.24, blue: 0.10)))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("call-offer-take-notes")
        }
        .padding(.leading, 16)
        .padding(.trailing, 12)
        .frame(width: 340, height: 64)
        .background(RoundedRectangle(cornerRadius: 16).fill(Color(red: 0.16, green: 0.13, blue: 0.11).opacity(0.96)))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.white.opacity(0.08)))
        .overlay(alignment: .topLeading) {
            // Close, shown on hover like a notification's.
            Button(action: dismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 8, weight: .bold))
                    .foregroundStyle(.white.opacity(0.8))
                    .frame(width: 18, height: 18)
                    .background(Circle().fill(Color(white: 0.3)))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
            .offset(x: -6, y: -6)
            .opacity(hovering ? 1 : 0)
        }
        .onHover { hovering = $0 }
        .padding(8)
    }
}
