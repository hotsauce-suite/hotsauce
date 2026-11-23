import AppKit
import DictateCore
import WebKit

/// The slides window of a presentation (docs/PLAN-slides.md R11): the page's
/// `window.open('about:blank#hotsauce-slides')`, which the page fills and drives itself. The app
/// only puts it full screen on the external display, so the main window keeps the presenter view.
@MainActor
final class SlidesWindow: NSObject, NSWindowDelegate, WKUIDelegate {
    let webView: WKWebView
    private let window: NSWindow
    private let onClose: () -> Void
    private var closing = false

    /// `configuration` is WebKit's own for the new window: it links the window to the page.
    init(configuration: WKWebViewConfiguration, avoiding presenterScreen: NSScreen?, onClose: @escaping () -> Void) {
        self.onClose = onClose
        let screen = NSScreen.screens.first { $0 != presenterScreen } ?? NSScreen.main ?? NSScreen.screens[0]
        webView = WKWebView(frame: screen.frame, configuration: configuration)
        window = NSWindow(
            contentRect: screen.visibleFrame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        super.init()
        webView.uiDelegate = self
        window.title = "Slides"
        window.isReleasedWhenClosed = false
        window.contentView = webView
        window.delegate = self
        window.tabbingMode = .disallowed
        window.collectionBehavior = [.fullScreenPrimary]
        window.setFrame(screen.visibleFrame, display: false)
        window.orderFront(nil)
        // Full screen on that display only when it is a second one: on the laptop's own screen the
        // presenter view would be hidden behind it.
        if screen != presenterScreen { window.toggleFullScreen(nil) }
    }

    /// The page closed it (the show ended).
    func webViewDidClose(_ webView: WKWebView) {
        closing = true
        window.close()
    }

    /// Closed by its own button or ⌘W: the page sees `closed` and offers to open it again.
    func windowWillClose(_ notification: Notification) {
        if !closing {
            closing = true
            webView.evaluateJavaScript("window.close()", completionHandler: nil)
        }
        window.delegate = nil
        // After this call returns: letting go of the window object while AppKit is still in it.
        let done = onClose
        DispatchQueue.main.async { done() }
    }
}
