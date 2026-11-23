import Foundation

/// Presenting a Doc as slides (docs/PLAN-slides.md R11). The page renders everything; the app
/// only places windows:
/// - It tells the page how many displays there are (`window.hotsauceMacDisplays`), so Present
///   picks presenter view by itself when there is a second screen.
/// - The page opens its slides window at `about:blank#hotsauce-slides`; the app puts that window
///   full screen on the external display and keeps the presenter view in the main window.
/// - With one display, the page asks for the main window to go full screen
///   (`hotsauceSlides.postMessage({fullScreen: true})`) and back.
/// - View → Present (⌘⌥P) asks the open doc's page to present (`window.hotsaucePresent`).
/// Pure: the names, the scripts and reading the page's messages, tested without a page.
public enum SlidesBridge {
    public static let handlerName = "hotsauceSlides"
    public static let windowAddress = "about:blank#hotsauce-slides"

    /// The page's slides window, and nothing else the page opens.
    public static func isSlidesWindow(_ url: URL?) -> Bool {
        url?.absoluteString == windowAddress
    }

    /// Tells the page how many displays the Mac has now.
    public static func displaysScript(count: Int) -> String {
        "window.hotsauceMacDisplays = \(max(1, count))"
    }

    /// Runs in the page: presents the open doc; false when no doc is open.
    public static let presentScript = """
    if (typeof window.hotsaucePresent !== 'function') return false;
    window.hotsaucePresent();
    return true;
    """

    public static let noDocMessage = "Open a doc to present it."

    public enum Message: Equatable, Sendable {
        case fullScreen(Bool)
    }

    /// The page's `{fullScreen: true|false}`; nil for anything else.
    public static func parse(_ body: Any?) -> Message? {
        guard let dict = body as? [String: Any], let on = dict["fullScreen"] as? Bool else { return nil }
        return .fullScreen(on)
    }
}
