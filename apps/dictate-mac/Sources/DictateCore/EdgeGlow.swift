import CoreGraphics
import Foundation

// The edge glow: while Dictate listens, a warm glow hugs the edges of the window being typed into,
// with flames along the bottom that follow the voice (docs/PLAN-dictate-edge-glow.md). The pieces
// here have no AppKit in them, so they can be tested; HearthDictate/EdgeGlow.swift draws it.

/// What the glow looks like. Every tunable lives here, so the look can be changed in one place.
public enum EdgeGlowLook {
    public struct RGB: Equatable, Sendable {
        public let red, green, blue: CGFloat
    }

    /// The thin bright line on every edge: amber, from the Hotsauce rust leaning toward gold.
    public static let line = RGB(red: 1.0, green: 0.71, blue: 0.36)
    /// The flames, from the hot base to the tips.
    public static let flameBase = RGB(red: 1.0, green: 0.80, blue: 0.46)
    public static let flameMiddle = RGB(red: 1.0, green: 0.50, blue: 0.19)
    public static let flameTip = RGB(red: 0.86, green: 0.29, blue: 0.11)

    /// Points. The line's width, how far its soft glow spreads, and the inner wash on each edge.
    public static let lineWidth: CGFloat = 2
    public static let lineGlowRadius: CGFloat = 10
    public static let innerWash: CGFloat = 22
    /// Corner radius for a window (macOS draws windows with rounded corners) and for a screen.
    public static let windowCornerRadius: CGFloat = 14
    public static let screenCornerRadius: CGFloat = 0

    /// Flame band height in points: resting, and how much the loudest voice adds.
    public static let flameRest: CGFloat = 14
    public static let flameRise: CGFloat = 90
    /// Flames never take more than this share of the window's height.
    public static let flameMaxShare: CGFloat = 1.0 / 3.0

    /// Seconds. Fading in when listening starts, the pulse while writing up, and the fade out.
    public static let fadeIn: TimeInterval = 0.15
    public static let pulse: TimeInterval = 1.1
    public static let fadeOut: TimeInterval = 0.25
    /// Opacity of the whole glow while writing up: it pulses between these.
    public static let thinkingOpacity: (low: Float, high: Float) = (0.45, 0.85)

    public static func flameHeight(level: Float, windowHeight: CGFloat) -> CGFloat {
        let level = CGFloat(min(1, max(0, level)))
        return min(flameRest + flameRise * level, windowHeight * flameMaxShare)
    }

    /// With Reduce motion on, the glow is static: no flames, no pulse.
    public static func animates(reduceMotion: Bool) -> Bool { !reduceMotion }
}

/// Where the glow goes: around the focused window, or the edges of a screen.
public enum EdgeGlowGeometry {
    public struct Placement: Equatable, Sendable {
        public let frame: CGRect
        /// True when it frames a whole screen (no window to frame, or one in full screen).
        public let isScreen: Bool

        public init(frame: CGRect, isScreen: Bool) {
            self.frame = frame
            self.isScreen = isScreen
        }
    }

    /// Smaller than this, a window is a palette or a popover: frame the screen instead.
    public static let minimumWindow = CGSize(width: 120, height: 80)
    /// A window within this many points of every screen edge counts as full screen.
    static let fullScreenSlack: CGFloat = 4

    /// The Accessibility API measures from the primary screen's top-left corner, y down; AppKit
    /// from its bottom-left, y up.
    public static func cocoaFrame(axPosition: CGPoint, axSize: CGSize, primaryScreenHeight: CGFloat) -> CGRect {
        CGRect(x: axPosition.x, y: primaryScreenHeight - axPosition.y - axSize.height, width: axSize.width, height: axSize.height)
    }

    /// `screens` are Cocoa frames, the primary first. Nil only with no screens at all.
    public static func placement(window: CGRect?, screens: [CGRect], mouse: CGPoint) -> Placement? {
        guard let fallback = screens.first(where: { $0.contains(mouse) }) ?? screens.first else { return nil }
        let screenPlacement = Placement(frame: fallback, isScreen: true)
        guard let window, !window.isNull, !window.isEmpty else { return screenPlacement }
        // The screen showing most of the window; the part hanging off it isn't drawn.
        let best = screens
            .map { (screen: $0, part: $0.intersection(window)) }
            .filter { !$0.part.isNull && !$0.part.isEmpty }
            .max { $0.part.width * $0.part.height < $1.part.width * $1.part.height }
        guard let best else { return screenPlacement }
        let part = best.part
        if part.width < minimumWindow.width || part.height < minimumWindow.height { return screenPlacement }
        if part.width >= best.screen.width - fullScreenSlack, part.height >= best.screen.height - fullScreenSlack {
            return Placement(frame: best.screen, isScreen: true)
        }
        return Placement(frame: part, isScreen: false)
    }
}

/// The microphone level as the flames use it: mapped like the pill's meter, then smoothed so the
/// flames jump with speech and settle slowly between words.
public struct EdgeGlowLevel: Sendable {
    /// Seconds to cover most of the way to a louder or a quieter target.
    public static let attack: Double = 0.04
    public static let release: Double = 0.35

    public private(set) var value: Float = 0
    private var goal: Float = 0

    public init() {}

    /// Speech sits low on a linear RMS scale; a square root spreads it out (as Overlay's meter).
    public static func normalized(_ raw: Float) -> Float {
        min(1, max(0, raw).squareRoot() * 2.2)
    }

    public mutating func target(raw: Float) { goal = Self.normalized(raw) }

    /// Moves toward the target for one frame of `dt` seconds.
    public mutating func step(dt: Double) {
        let tau = goal > value ? Self.attack : Self.release
        let k = Float(1 - exp(-max(0, dt) / tau))
        value += (goal - value) * k
    }

    public mutating func reset() {
        value = 0
        goal = 0
    }
}

/// The glow's life: idle → listening → thinking (writing up) → fading → idle.
public struct EdgeGlowMachine: Sendable {
    public enum Phase: Equatable, Sendable { case idle, listening, thinking, fading }
    public enum Event: Sendable {
        /// Recording started.
        case listen
        /// The recording is being written up.
        case think
        /// Pasted, copied, cancelled, too short, or failed.
        case finish
        /// The fade-out finished.
        case faded
    }

    public private(set) var phase: Phase = .idle

    public init() {}

    /// The new phase, or nil when the event changes nothing.
    public mutating func handle(_ event: Event) -> Phase? {
        let next: Phase? = switch (phase, event) {
        case (.idle, .listen), (.fading, .listen): .listening
        // Only a dictation that was listening is written up with a glow; a retry from the menu isn't.
        case (.listening, .think): .thinking
        case (.listening, .finish), (.thinking, .finish): .fading
        case (.fading, .faded): .idle
        default: nil
        }
        if let next { phase = next }
        return next
    }
}

/// "Edge glow while dictating" in Settings → Dictation; on by default.
public enum EdgeGlowSetting {
    public static let key = "edgeGlow"

    public static func isOn(_ defaults: UserDefaults) -> Bool {
        defaults.object(forKey: key) as? Bool ?? true
    }

    public static func set(_ on: Bool, in defaults: UserDefaults) {
        defaults.set(on, forKey: key)
    }
}
