import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Smart selection for screenshots (docs/PLAN-screenshots.md R8): drag for an area, click a window
// for that window, click the desktop for the whole display, and the crop of the frozen frame in
// native pixels. All in global points with the origin at the top-left of the main display and y
// growing down, as CGDisplayBounds, CGWindowList and ScreenCaptureKit give them.

/// One display as it was captured.
public struct CaptureDisplay: Equatable, Sendable {
    public var id: UInt32
    /// Its bounds in global points.
    public var frame: CGRect
    /// The size of the captured frame in pixels. Over the frame's points this is the scale: 2 on
    /// a Retina screen, and a fraction on some scaled modes.
    public var pixelWidth: Int
    public var pixelHeight: Int

    public init(id: UInt32, frame: CGRect, pixelWidth: Int, pixelHeight: Int) {
        self.id = id
        self.frame = frame
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
    }

    public var scaleX: CGFloat { frame.width > 0 ? CGFloat(pixelWidth) / frame.width : 1 }
    public var scaleY: CGFloat { frame.height > 0 ? CGFloat(pixelHeight) / frame.height : 1 }

    /// A global rectangle as whole pixels of this display's frame (origin top-left), rounded out
    /// so nothing the selection touches is lost and clamped to the frame. Nil when it misses.
    public func pixelRect(for rect: CGRect) -> CGRect? {
        let clipped = rect.intersection(frame)
        guard !clipped.isNull, clipped.width > 0, clipped.height > 0 else { return nil }
        // A hair of tolerance, so 749.9999 pixels from a fractional scale stays 750.
        let tolerance: CGFloat = 0.001
        let minX = max(0, floor((clipped.minX - frame.minX) * scaleX + tolerance))
        let minY = max(0, floor((clipped.minY - frame.minY) * scaleY + tolerance))
        let maxX = min(CGFloat(pixelWidth), ceil((clipped.maxX - frame.minX) * scaleX - tolerance))
        let maxY = min(CGFloat(pixelHeight), ceil((clipped.maxY - frame.minY) * scaleY - tolerance))
        guard maxX > minX, maxY > minY else { return nil }
        return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }

    /// The size the readout shows: width × height in pixels.
    public func pixelSize(of rect: CGRect) -> (width: Int, height: Int) {
        guard let pixels = pixelRect(for: rect) else { return (0, 0) }
        return (Int(pixels.width), Int(pixels.height))
    }

    /// A global point in this display's pixels, for the pointer readout.
    public func pixelPoint(for point: CGPoint) -> (x: Int, y: Int) {
        let x = Int(((min(max(point.x, frame.minX), frame.maxX) - frame.minX) * scaleX).rounded(.down))
        let y = Int(((min(max(point.y, frame.minY), frame.maxY) - frame.minY) * scaleY).rounded(.down))
        return (min(x, max(0, pixelWidth - 1)), min(y, max(0, pixelHeight - 1)))
    }
}

/// A window on screen, as the window list reports it.
public struct CaptureWindow: Equatable, Sendable {
    public var id: UInt32
    /// Global points.
    public var frame: CGRect
    /// Its window level: 0 for ordinary windows, negative for the desktop, 20 and up for the Dock,
    /// the menu bar and menus.
    public var layer: Int
    public var ownerPID: Int32
    public var ownerName: String?
    public var alpha: Double

    public init(id: UInt32, frame: CGRect, layer: Int, ownerPID: Int32, ownerName: String?, alpha: Double = 1) {
        self.id = id
        self.frame = frame
        self.layer = layer
        self.ownerPID = ownerPID
        self.ownerName = ownerName
        self.alpha = alpha
    }
}

/// What a click or a drag picked.
public struct CaptureSelection: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case area
        case window(UInt32)
        case display
    }

    public var kind: Kind
    /// Global points, inside the display.
    public var rect: CGRect

    public init(kind: Kind, rect: CGRect) {
        self.kind = kind
        self.rect = rect
    }
}

public enum CaptureGeometry {
    /// A drag shorter than this many points each way is a click.
    public static let clickTolerance: CGFloat = 4
    /// Windows smaller than this either way (tooltips, slivers) can't be picked.
    public static let smallestWindow: CGFloat = 24
    /// kCGDockWindowLevel: the Dock and everything above it (menu bar, menus, the overlay itself).
    static let dockLayer = 20

    /// The rectangle between where a drag started and where the pointer is, whichever way it went.
    public static func dragRect(from start: CGPoint, to end: CGPoint) -> CGRect {
        CGRect(x: min(start.x, end.x), y: min(start.y, end.y), width: abs(end.x - start.x), height: abs(end.y - start.y))
    }

    public static func isClick(from start: CGPoint, to end: CGPoint) -> Bool {
        abs(end.x - start.x) < clickTolerance && abs(end.y - start.y) < clickTolerance
    }

    /// The windows a click can pick, still front to back: ordinary and floating windows of other
    /// apps. Not the desktop, the Dock, the menu bar, invisible windows, slivers, or ours.
    public static func pickableWindows(_ windows: [CaptureWindow], ownPID: Int32) -> [CaptureWindow] {
        windows.filter { window in
            window.layer >= 0 && window.layer < dockLayer
                && window.ownerPID != ownPID
                && window.alpha > 0
                && window.ownerName != "Dock" && window.ownerName != "Window Server"
                && window.frame.width >= smallestWindow && window.frame.height >= smallestWindow
        }
    }

    /// The frontmost window under a point, from a front-to-back list.
    public static func window(at point: CGPoint, in windows: [CaptureWindow]) -> CaptureWindow? {
        windows.first { $0.frame.contains(point) }
    }

    /// What the pointer would pick on a click here: the window under it (trimmed to the display),
    /// or the whole display over bare desktop.
    public static func hover(at point: CGPoint, windows: [CaptureWindow], display: CaptureDisplay) -> CaptureSelection {
        if let window = window(at: point, in: windows) {
            let trimmed = window.frame.intersection(display.frame)
            if !trimmed.isNull, trimmed.width > 0, trimmed.height > 0 {
                return CaptureSelection(kind: .window(window.id), rect: trimmed)
            }
        }
        return CaptureSelection(kind: .display, rect: display.frame)
    }

    /// The pick when the button comes up: a click picks as `hover` does; a drag is its rectangle,
    /// kept inside the display the drag started on.
    public static func selection(from start: CGPoint, to end: CGPoint, windows: [CaptureWindow], display: CaptureDisplay) -> CaptureSelection {
        if isClick(from: start, to: end) { return hover(at: start, windows: windows, display: display) }
        let rect = dragRect(from: start, to: end).intersection(display.frame)
        return CaptureSelection(kind: .area, rect: rect.isNull ? .zero : rect)
    }

    /// AppKit's global coordinates (origin bottom-left of the main display, y up) to global
    /// top-left points, and back: the same flip both ways.
    public static func flipped(_ point: CGPoint, mainDisplayHeight: CGFloat) -> CGPoint {
        CGPoint(x: point.x, y: mainDisplayHeight - point.y)
    }

    public static func flipped(_ rect: CGRect, mainDisplayHeight: CGFloat) -> CGRect {
        CGRect(x: rect.minX, y: mainDisplayHeight - rect.maxY, width: rect.width, height: rect.height)
    }
}

/// Turning the frozen frame into the picture: crop and PNG.
public enum ScreenshotImage {
    /// The part of a display's frozen frame under a selection. The frame's own size wins over
    /// the display's recorded pixel size, should they differ.
    public static func crop(_ frame: CGImage, display: CaptureDisplay, to rect: CGRect) -> CGImage? {
        var sized = display
        sized.pixelWidth = frame.width
        sized.pixelHeight = frame.height
        guard let pixels = sized.pixelRect(for: rect) else { return nil }
        return frame.cropping(to: pixels)
    }

    public static func png(_ image: CGImage) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }
}

/// Saved shots' names, as macOS names its own: "Screenshot 2026-11-19 at 14.03.09.png".
public enum ScreenshotFiles {
    public static func baseName(for date: Date, timeZone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let c = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        func two(_ value: Int?) -> String { String(format: "%02d", value ?? 0) }
        return "Screenshot \(c.year ?? 0)-\(two(c.month))-\(two(c.day)) at \(two(c.hour)).\(two(c.minute)).\(two(c.second))"
    }

    /// The first free name: the plain one, then " 2", " 3"… when a shot of the same second is there.
    public static func fileName(for date: Date, timeZone: TimeZone = .current, isTaken: (String) -> Bool) -> String {
        let base = baseName(for: date, timeZone: timeZone)
        var name = base + ".png"
        var number = 2
        while isTaken(name) {
            name = "\(base) \(number).png"
            number += 1
        }
        return name
    }
}

/// The newest few captures, newest first, for the preview and the editor.
public struct RecentCaptures<Capture> {
    public let capacity: Int
    public private(set) var items: [Capture] = []

    public init(capacity: Int = 5) {
        self.capacity = capacity
    }

    public var newest: Capture? { items.first }

    public mutating func add(_ capture: Capture) {
        items.insert(capture, at: 0)
        if items.count > capacity { items.removeLast(items.count - capacity) }
    }
}

/// One capture at a time: the shortcut starts one, pressing it again while choosing cancels it.
public struct ScreenshotSession: Equatable, Sendable {
    public enum Phase: Equatable, Sendable {
        case idle
        /// Grabbing the displays' frames; the overlay isn't up yet.
        case capturing
        /// The overlay is up.
        case choosing
    }

    public enum Action: Equatable, Sendable {
        case none
        case start
        case dismiss
    }

    public private(set) var phase: Phase = .idle

    public init() {}

    public var isActive: Bool { phase != .idle }

    public mutating func shortcutPressed() -> Action {
        switch phase {
        case .idle:
            phase = .capturing
            return .start
        case .capturing:
            return .none
        case .choosing:
            phase = .idle
            return .dismiss
        }
    }

    /// The frames are in and the overlay shows.
    public mutating func captured() {
        if phase == .capturing { phase = .choosing }
    }

    /// Esc, a pick, or a failed grab: back to idle. True when there was something to end.
    @discardableResult
    public mutating func end() -> Bool {
        defer { phase = .idle }
        return phase != .idle
    }
}
