import AppKit
import DictateCore
import Network
import WebKit

/// The app's main window: the whole web suite in a web view. The web view lives as long as the
/// app (closing the window only hides it), so the session, an open recording and the meeting
/// reminders' calls keep going. Its cookies and storage are the default persistent store, so a
/// sign-in survives relaunching the app.
@MainActor
final class SuiteWindow: NSObject, NSWindowDelegate, NSToolbarDelegate, WKNavigationDelegate, WKUIDelegate,
    WKDownloadDelegate, WKScriptMessageHandler
{
    let webView: WKWebView
    private let window: NSWindow
    private(set) var router: SuiteRouter
    /// A short message for the member (a finished download); the app shows it in its overlay.
    var showMessage: (String) -> Void = { _ in }
    /// The app's own links (`hearth-dictate://connect`, `hearth://<path>`) found in the page.
    var handleAppLink: (URL) -> Void = { _ in }
    /// The page wants to sign in: the app does it through the member's browser.
    var signInWithBrowser: () -> Void = {}
    /// The server answered from a new address (it moved): the app remembers the new one.
    var serverMoved: (_ from: URL, _ to: URL) -> Void = { _, _ in }
    /// The suite page that couldn't be loaded, while the window shows the "Can't reach" page.
    private var failedURL: URL?
    private var failures = 0
    private var retryTimer: Timer?
    /// The suite answered with a server error (a proxy's 502 while the server restarts).
    private var answeredWithServerError = false
    private var checkingMove = false
    private let pathMonitor = NWPathMonitor()
    private var destinations: [ObjectIdentifier: URL] = [:]
    private var titleObservation: NSKeyValueObservation?
    private var historyObservations: [NSKeyValueObservation] = []
    private var hasLoaded = false
    /// The meeting recording of "Any app on this Mac", while the Meetings page has one going.
    private var meetingCapture: AnyObject?

    init(server: URL) {
        router = SuiteRouter(server: server)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        // Google refuses to sign in inside apps that don't look like a browser; WebKit's own
        // user agent plus Safari's version is exactly what Safari sends.
        configuration.applicationNameForUserAgent = "Version/18.5 Safari/605.1.15"
        configuration.preferences.isElementFullscreenEnabled = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.userContentController.addUserScript(WKUserScript(
            source: Self.downloadLinkScript, injectionTime: .atDocumentStart, forMainFrameOnly: true
        ))
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 820), configuration: configuration)
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsMagnification = true
        // Safari's Web Inspector, only when turned on: `defaults write dev.hotsauce.dictate webInspector -bool true`.
        if #available(macOS 13.3, *) { webView.isInspectable = UserDefaults.standard.bool(forKey: "webInspector") }

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        super.init()
        configuration.userContentController.add(WeakScriptHandler(self), name: "hearthDownload")
        // The sign-in page's "Sign in with your browser" (apps/web/src/lib/desktop.ts).
        configuration.userContentController.add(WeakScriptHandler(self), name: "hearthSignIn")
        // /desktop/finish takes the ticket the app received, once (never from its URL).
        configuration.userContentController.addScriptMessageHandler(TicketHandler(self), contentWorld: .page, name: "hearthTicket")
        // Meetings' "Any app on this Mac" (docs/PLAN-record-any-call.md): process taps need 14.2.
        if #available(macOS 14.2, *) {
            configuration.userContentController.addUserScript(WKUserScript(
                source: "window.hearthMac = Object.freeze({ meetingAudio: 1 })", injectionTime: .atDocumentStart, forMainFrameOnly: true
            ))
            configuration.userContentController.addScriptMessageHandler(MeetingAudioHandler(self), contentWorld: .page, name: MeetingAudio.handlerName)
        }
        webView.navigationDelegate = self
        webView.uiDelegate = self

        window.title = Brand.name
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 640, height: 480)
        window.delegate = self
        window.contentView = webView
        window.tabbingMode = .disallowed
        let toolbar = NSToolbar(identifier: "SuiteToolbar")
        toolbar.delegate = self
        toolbar.displayMode = .iconOnly
        window.toolbar = toolbar
        window.toolbarStyle = .unifiedCompact
        window.setFrameAutosaveName("SuiteWindow")
        if !window.setFrameUsingName("SuiteWindow") { window.center() }

        titleObservation = webView.observe(\.title, options: [.new]) { [weak self] view, _ in
            MainActor.assumeIsolated {
                let title = view.title ?? ""
                self?.window.title = title.isEmpty ? Brand.name : title
            }
        }
        historyObservations = [
            webView.observe(\.canGoBack) { [weak self] _, _ in MainActor.assumeIsolated { self?.window.toolbar?.validateVisibleItems() } },
            webView.observe(\.canGoForward) { [weak self] _, _ in MainActor.assumeIsolated { self?.window.toolbar?.validateVisibleItems() } },
        ]
        // Back online (a Mac waking up, the VPN reconnecting): try a failed load again at once.
        pathMonitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.retryNow() } }
        }
        pathMonitor.start(queue: DispatchQueue(label: "SuiteWindow.path"))
    }

    var isKey: Bool { window.isKeyWindow }

    /// Loads the suite if it hasn't been yet; without showing the window (a login launch).
    func loadIfNeeded() {
        guard !hasLoaded else { return }
        hasLoaded = true
        webView.load(URLRequest(url: router.server))
    }

    func show() {
        loadIfNeeded()
        retryNow()
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    /// Another server (Settings): start again there.
    func setServer(_ server: URL) {
        guard server != router.server else { return }
        router = SuiteRouter(server: server)
        stopRetrying()
        hasLoaded = true
        webView.load(URLRequest(url: server))
    }

    /// Opens a path of the suite (`/meetings/start?event=x`). On a page of the suite already, it
    /// changes route in place, as the web app's own links do, so a recording isn't reloaded.
    func open(path: String) {
        guard let url = router.url(forPath: path) else { return }
        hasLoaded = true
        if let current = webView.url, router.isSuite(current), !webView.isLoading {
            Task {
                do {
                    _ = try await webView.callAsyncJavaScript(
                        "history.pushState(null, '', path); window.dispatchEvent(new PopStateEvent('popstate', { state: null }))",
                        arguments: ["path": path], in: nil, contentWorld: .page
                    )
                } catch {
                    webView.load(URLRequest(url: url))
                }
            }
        } else {
            webView.load(URLRequest(url: url))
        }
    }

    /// The ticket from the browser, waiting for /desktop/finish to take it.
    private var pendingTicket: (ticket: String, received: Date)?

    /// Finishes a browser sign-in: the suite's page that asks for the ticket and redeems it.
    func finishSignIn(ticket: String) {
        guard let url = BrowserSignIn.finishURL(server: router.server) else { return }
        pendingTicket = (ticket, Date())
        hasLoaded = true
        webView.load(URLRequest(url: url))
        show()
    }

    /// Hands the pending ticket to the suite's own finish page, once, while it's fresh.
    fileprivate func takeTicket(from message: WKScriptMessage) -> String? {
        guard message.frameInfo.isMainFrame, let page = message.frameInfo.request.url ?? webView.url,
              router.isSuite(page), page.path == "/desktop/finish",
              let pending = pendingTicket
        else { return nil }
        pendingTicket = nil
        return Date().timeIntervalSince(pending.received) <= BrowserSignIn.ticketHandoff ? pending.ticket : nil
    }

    /// Answers the Meetings page's start, pause, resume and stop for "Any app on this Mac". Start
    /// only from a Meetings page of the suite (the rest from any suite page, since a recording
    /// follows the member around the suite), in its main frame; one recording at a time, a new start
    /// ending the old one (whose page is told both tracks ended).
    @available(macOS 14.2, *)
    fileprivate func meetingAudio(_ message: WKScriptMessage) -> Any? {
        guard message.frameInfo.isMainFrame, isSuiteFrame(message.frameInfo),
              let command = MeetingAudio.Command.parse(message.body)
        else { return nil }
        if command == .start, !isOnMeetingsPage { return MeetingAudio.failed(.unsupported, message: "Start from Meetings.") }
        let current = meetingCapture as? MeetingCapture
        switch command {
        case .stop(let session):
            if current?.session == session { stopMeetingCapture() }
            return nil
        case .pause(let session):
            if current?.session == session { current?.setPaused(true) }
            return nil
        case .resume(let session):
            if current?.session == session { current?.setPaused(false) }
            return nil
        case .start:
            if let current {
                sendMeetingEvent(MeetingAudio.endedEvent(session: current.session, track: .me))
                sendMeetingEvent(MeetingAudio.endedEvent(session: current.session, track: .them))
            }
            stopMeetingCapture()
            let capture = MeetingCapture()
            let session = capture.session
            capture.onFrames = { [weak self] me, them in
                self?.sendMeetingEvent(MeetingAudio.framesEvent(session: session, me: me, them: them))
            }
            capture.onEnded = { [weak self] track in
                self?.sendMeetingEvent(MeetingAudio.endedEvent(session: session, track: track))
            }
            do {
                try capture.start()
            } catch MeetingCapture.CaptureError.failed(let reason, let text) {
                return MeetingAudio.failed(reason, message: text)
            } catch {
                return MeetingAudio.failed(.unsupported, message: "\(Brand.name) couldn’t start recording.")
            }
            meetingCapture = capture
            return MeetingAudio.started(session: session)
        }
    }

    /// The frame's own origin is the suite's, and so is the page the web view shows.
    private func isSuiteFrame(_ frame: WKFrameInfo) -> Bool {
        let origin = frame.securityOrigin
        var components = URLComponents()
        components.scheme = origin.protocol
        components.host = origin.host
        if origin.port != 0 { components.port = origin.port }
        guard let originURL = components.url, router.isSuite(originURL) else { return false }
        return isOnSuitePage
    }

    private var isOnSuitePage: Bool {
        guard let current = webView.url else { return false }
        return router.isSuite(current)
    }

    private var isOnMeetingsPage: Bool {
        guard let current = webView.url, router.isSuite(current) else { return false }
        return MeetingAudio.isMeetingsPath(current.path)
    }

    /// The "Any app on this Mac" recording of a live meeting (paused counts), by its session. Nil
    /// while the Start page only checks the sound: nothing is recorded there yet.
    var recordingMeetingSession: String? {
        guard #available(macOS 14.2, *), let capture = meetingCapture as? MeetingCapture else { return nil }
        if let current = webView.url, router.isSuite(current), current.path == "/meetings/start" { return nil }
        return capture.session
    }

    /// Tells the recording page its call ended (`CallDetector`), if that recording still runs.
    func meetingCallEnded(session: String) {
        guard #available(macOS 14.2, *), let capture = meetingCapture as? MeetingCapture, capture.session == session else { return }
        sendMeetingEvent(MeetingAudio.callEndedEvent(session: session))
    }

    /// Ends any meeting recording: the page stopped it, or the page itself went away.
    func stopMeetingCapture() {
        guard let capture = meetingCapture else { return }
        meetingCapture = nil
        if #available(macOS 14.2, *), let capture = capture as? MeetingCapture {
            capture.onFrames = { _, _ in }
            capture.onEnded = { _ in }
            capture.stop()
        }
    }

    /// Audio goes only to the suite's page, checked again as each batch is sent. Not only its
    /// Meetings routes: a recording keeps going while the member moves to Docs or Tasks.
    private func sendMeetingEvent(_ detail: [String: Any]) {
        guard isOnSuitePage else { return }
        Task {
            guard isOnSuitePage else { return }
            _ = try? await webView.callAsyncJavaScript(MeetingAudio.dispatchScript, arguments: ["detail": detail], in: nil, contentWorld: .page)
        }
    }

    func reload() {
        if webView.url == nil || webView.url?.scheme == "about" { webView.load(URLRequest(url: router.server)) } else { webView.reload() }
    }

    func goBack() { webView.goBack() }
    func goForward() { webView.goForward() }
    func goHome() { webView.load(URLRequest(url: router.server)) }
    var canGoBack: Bool { webView.canGoBack }
    var canGoForward: Bool { webView.canGoForward }

    /// GETs a suite API path from inside the signed-in page, with the page's own credentials:
    /// Clerk's session token when there is one, the dev sign-in's header locally, and the session
    /// cookie either way. Nil when the page isn't the suite (signed out, an error page) or the
    /// request fails; the status code otherwise.
    func apiGet(_ path: String) async -> (status: Int, body: Data?)? {
        guard path.hasPrefix("/api/"), let current = webView.url, router.isSuite(current) else { return nil }
        let script = """
        const headers = {}
        try { const token = await window.Clerk?.session?.getToken(); if (token) headers.Authorization = 'Bearer ' + token } catch {}
        try { const dev = localStorage.getItem('hearth.devUser'); if (dev && !headers.Authorization) headers['x-hearth-dev-user'] = dev } catch {}
        const response = await fetch(path, { headers, credentials: 'same-origin', cache: 'no-store' })
        return { status: response.status, body: response.ok ? await response.text() : '' }
        """
        do {
            let result = try await webView.callAsyncJavaScript(script, arguments: ["path": path], in: nil, contentWorld: .page)
            guard let dict = result as? [String: Any], let status = dict["status"] as? Int else { return nil }
            let body = (dict["body"] as? String).flatMap { $0.isEmpty ? nil : Data($0.utf8) }
            return (status, body)
        } catch {
            return nil
        }
    }

    // MARK: Window

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        // Hidden, not closed: the page keeps its session, its recording and its timers.
        sender.orderOut(nil)
        return false
    }

    // MARK: Toolbar

    private static let backItem = NSToolbarItem.Identifier("back")
    private static let forwardItem = NSToolbarItem.Identifier("forward")
    private static let reloadItem = NSToolbarItem.Identifier("reload")

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [Self.backItem, Self.forwardItem, Self.reloadItem, .flexibleSpace]
    }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [Self.backItem, Self.forwardItem, Self.reloadItem, .flexibleSpace]
    }

    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
        let item = ValidatedToolbarItem(itemIdentifier: id)
        item.isBordered = true
        item.target = self
        switch id {
        case Self.backItem:
            item.label = "Back"
            item.image = NSImage(systemSymbolName: "chevron.left", accessibilityDescription: "Back")
            item.action = #selector(backClicked)
            item.isEnabledCheck = { [weak self] in self?.canGoBack ?? false }
        case Self.forwardItem:
            item.label = "Forward"
            item.image = NSImage(systemSymbolName: "chevron.right", accessibilityDescription: "Forward")
            item.action = #selector(forwardClicked)
            item.isEnabledCheck = { [weak self] in self?.canGoForward ?? false }
        case Self.reloadItem:
            item.label = "Reload"
            item.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: "Reload")
            item.action = #selector(reloadClicked)
        default:
            return nil
        }
        item.toolTip = item.label
        return item
    }

    @objc private func backClicked() { goBack() }
    @objc private func forwardClicked() { goForward() }
    @objc private func reloadClicked() { reload() }

    // MARK: Navigation

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { return decisionHandler(.download) }
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        let decision = router.decide(
            url,
            isMainFrame: action.targetFrame?.isMainFrame ?? true,
            userClicked: action.navigationType == .linkActivated,
            newWindow: action.targetFrame == nil
        )
        switch decision {
        case .allow:
            decisionHandler(.allow)
        case .cancel:
            decisionHandler(.cancel)
        case let .handleInApp(link):
            decisionHandler(.cancel)
            handleAppLink(link)
        case .signInWithBrowser:
            decisionHandler(.cancel)
            stopRetrying()
            signInWithBrowser()
        case .openExternally:
            decisionHandler(.cancel)
            // Not a click (a redirect, a script): maybe the server moved to a new address.
            if action.navigationType != .linkActivated, action.targetFrame?.isMainFrame ?? true,
               ["http", "https"].contains(url.scheme?.lowercased() ?? "")
            {
                // A retry that ends up elsewhere (a login proxy) isn't retried again on its own.
                stopRetrying()
                guard !checkingMove else { return }
                checkingMove = true
                let server = router.server
                Task {
                    let moved = await followMove(to: url)
                    checkingMove = false
                    // Lost a race with another move: the window is already somewhere new.
                    if !moved, router.server == server { NSWorkspace.shared.open(url) }
                }
            } else {
                NSWorkspace.shared.open(url)
            }
        case let .loadInWindow(target):
            decisionHandler(.cancel)
            webView.load(URLRequest(url: target))
        }
    }

    /// Follows the suite to `target` if the server itself says it now lives there (`publicUrl` in
    /// its /api/health): an instance that changed address forwards its old one to the new one.
    private func followMove(to target: URL) async -> Bool {
        let old = router.server
        guard let health = ServerAddress.healthURL(server: old) else { return false }
        var request = URLRequest(url: health, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        guard let (data, response) = try? await URLSession(configuration: .ephemeral).data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let reported = ServerAddress.reportedOrigin(healthJSON: data),
              ServerAddress.isMove(from: old, to: target, reported: reported),
              router.server == old
        else { return false }
        router = SuiteRouter(server: reported)
        stopRetrying()
        hasLoaded = true
        webView.load(URLRequest(url: target))
        serverMoved(old, reported)
        return true
    }

    /// A suite page finished: the server is reachable again, unless what answered was an error.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let current = webView.url, router.isSuite(current) else { return }
        if answeredWithServerError {
            scheduleRetry(of: current)
        } else {
            stopRetrying()
        }
    }

    private func stopRetrying() {
        failures = 0
        failedURL = nil
        retryTimer?.invalidate()
        retryTimer = nil
    }

    /// Tries `url` again after a wait that grows with each failure in a row.
    private func scheduleRetry(of url: URL) {
        failures += 1
        failedURL = url
        retryTimer?.invalidate()
        retryTimer = Timer.scheduledTimer(withTimeInterval: RetryBackoff.delay(afterFailures: failures), repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.retryNow() }
        }
    }

    /// Loads the failed page again now (the window was opened, or the network came back).
    private func retryNow() {
        guard let url = failedURL, !webView.isLoading else { return }
        retryTimer?.invalidate()
        retryTimer = nil
        webView.load(URLRequest(url: url))
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void) {
        let http = response.response as? HTTPURLResponse
        if response.isForMainFrame, let url = http?.url {
            answeredWithServerError = router.isSuite(url) && (http?.statusCode ?? 0) >= 500
        }
        let disposition = http?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        // Only the page itself: an iframe's response never starts a download.
        if response.isForMainFrame, !response.canShowMIMEType || disposition.lowercased().hasPrefix("attachment") {
            decisionHandler(.download)
        } else {
            decisionHandler(.allow)
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showLoadError(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showLoadError(error)
    }

    /// A new page replaced the one that was recording (a reload, a sign-out): stop listening.
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        stopMeetingCapture()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        stopMeetingCapture()
        // At most once a minute, so a page that keeps crashing doesn't loop.
        guard Date().timeIntervalSince(lastCrashReload) > 60 else { return }
        lastCrashReload = Date()
        reload()
    }

    private var lastCrashReload = Date.distantPast

    /// Offline or the server down: a plain page that says so, with a way back.
    private func showLoadError(_ error: Error) {
        let nsError = error as NSError
        // Cancelled (a new navigation started), or a response that became a download.
        if nsError.code == NSURLErrorCancelled || (nsError.domain == "WebKitErrorDomain" && nsError.code == 102) { return }
        let failing = (nsError.userInfo[NSURLErrorFailingURLErrorKey] as? URL) ?? router.server
        let retry = router.isSuite(failing) ? failing : router.server
        // Try again by itself: a server restarting for an update is back in seconds, and a Mac
        // that opened the app at login may not be online yet.
        scheduleRetry(of: retry)
        let html = """
        <!doctype html><meta charset="utf-8"><title>\(escape(Brand.name))</title>
        <style>
        :root { color-scheme: light dark; --ink: #2A221D; --soft: #5B4E44; --paper: #F2EADF; --accent: #\(String(format: "%06X", Brand.accentLight)); }
        @media (prefers-color-scheme: dark) { :root { --ink: #EDE3D6; --soft: #C1B2A2; --paper: #1D1815; --accent: #\(String(format: "%06X", Brand.accentDark)); } }
        body { font: 14px -apple-system, system-ui; background: var(--paper); color: var(--ink); display: grid; place-items: center; height: 100vh; margin: 0; }
        h1 { font: 600 22px ui-serif, Georgia, serif; margin: 0 0 8px; }
        p { color: var(--soft); margin: 0 0 20px; max-width: 420px; }
        a { color: white; background: var(--accent); padding: 8px 16px; border-radius: 8px; text-decoration: none; font-weight: 600; }
        </style>
        <div><h1>Can’t reach \(escape(Brand.name))</h1><p>\(escape(nsError.localizedDescription)) Trying again by itself…</p><a href="\(escape(retry.absoluteString))">Try again</a></div>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    private func escape(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
    }

    // MARK: Windows, panels and permissions the page asks for

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = action.request.url, url.absoluteString != "about:blank" else { return nil }
        // WebKit only asks here on a click (scripts can't open windows on their own).
        switch router.decide(url, isMainFrame: true, userClicked: true, newWindow: true) {
        case let .loadInWindow(target): webView.load(URLRequest(url: target))
        case .openExternally: NSWorkspace.shared.open(url)
        case let .handleInApp(link): handleAppLink(link)
        case .signInWithBrowser: signInWithBrowser()
        case .allow, .cancel: break
        }
        return nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    /// Camera and microphone for Meetings and Clips: granted to the suite's own pages (macOS
    /// still asks once for the app); anyone else is asked about.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping @MainActor (WKPermissionDecision) -> Void) {
        var components = URLComponents()
        components.scheme = origin.protocol
        components.host = origin.host
        if origin.port != 0 { components.port = origin.port }
        if let url = components.url, router.isSuite(url) { decisionHandler(.grant) } else { decisionHandler(.prompt) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    // MARK: Downloads

    /// Links with a `download` attribute are downloaded by the app: WebKit ignores the attribute
    /// on another origin's link (a clip's presigned storage URL) and would navigate away.
    private static let downloadLinkScript = """
    document.addEventListener('click', (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const link = event.target instanceof Element ? event.target.closest('a[download]') : null
      if (!link || !/^https?:/i.test(link.href)) return
      event.preventDefault()
      window.webkit.messageHandlers.hearthDownload.postMessage(link.href)
    }, true)
    """

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        // Only the suite's own page, not an iframe or a page elsewhere.
        guard message.frameInfo.isMainFrame, let page = message.frameInfo.request.url ?? webView.url,
              router.isSuite(page)
        else { return }
        if message.name == "hearthSignIn" { return signInWithBrowser() }
        guard message.name == "hearthDownload",
              let text = message.body as? String, let url = URL(string: text),
              ["http", "https"].contains(url.scheme?.lowercased() ?? "")
        else { return }
        webView.startDownload(using: URLRequest(url: url)) { [weak self] download in
            download.delegate = self
        }
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping @MainActor (URL?) -> Void) {
        let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Downloads")
        let destination = DownloadName.unique(suggestedFilename, in: folder)
        destinations[ObjectIdentifier(download)] = destination
        completionHandler(destination)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let destination = destinations.removeValue(forKey: ObjectIdentifier(download)) else { return }
        // Bounces the Downloads stack in the Dock, as Safari's downloads do.
        DistributedNotificationCenter.default().post(name: .init("com.apple.DownloadFileFinished"), object: destination.path)
        showMessage("Downloaded \(destination.lastPathComponent)")
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let destination = destinations.removeValue(forKey: ObjectIdentifier(download))
        showMessage("Download failed\(destination.map { ": \($0.lastPathComponent)" } ?? "")")
    }
}

/// A toolbar button that asks whether it's enabled each time the toolbar validates.
private final class ValidatedToolbarItem: NSToolbarItem {
    var isEnabledCheck: (() -> Bool)?
    override func validate() {
        isEnabled = isEnabledCheck?() ?? true
    }
}

/// The content controller keeps its handlers alive; this keeps it from keeping the window alive.
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: (any WKScriptMessageHandler)?
    init(_ target: any WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

/// Answers /desktop/finish's `hearthTicket.postMessage('take')` with the app's pending ticket.
private final class TicketHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var suite: SuiteWindow?
    init(_ suite: SuiteWindow) { self.suite = suite }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping @MainActor (Any?, String?) -> Void) {
        MainActor.assumeIsolated {
            replyHandler(suite?.takeTicket(from: message), nil)
        }
    }
}

/// Answers the Meetings page's `hearthMeetingAudio.postMessage({type:'start'|'stop'})`.
@available(macOS 14.2, *)
private final class MeetingAudioHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var suite: SuiteWindow?
    init(_ suite: SuiteWindow) { self.suite = suite }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping @MainActor (Any?, String?) -> Void) {
        MainActor.assumeIsolated {
            replyHandler(suite?.meetingAudio(message), nil)
        }
    }
}
