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
    /// Nil until this Mac has a workspace: the window then shows its own page and loads nothing.
    private(set) var router: SuiteRouter?
    /// The workspace's address, once there is one.
    var server: URL? { router?.server }
    /// A short message for the member (a finished download); the app shows it in its overlay.
    var showMessage: (String) -> Void = { _ in }
    /// The app's own links (`hearth-dictate://connect`, `hearth://<path>`) found in the page.
    var handleAppLink: (URL) -> Void = { _ in }
    /// The page wants to sign in: the app does it through the member's browser.
    var signInWithBrowser: () -> Void = {}
    /// The server answered from a new address (it moved): the app remembers the new one.
    var serverMoved: (_ from: URL, _ to: URL) -> Void = { _, _ in }
    /// The window's own page asked for another workspace address: the app opens the Workspace step.
    var changeWorkspace: () -> Void = {}
    /// Whether this Mac needs a Dictate connection to `server` (R8).
    var dictateNeeded: (_ server: URL) -> Bool = { _ in false }
    /// Saves a device token from the finish page as the Mac's connection to `server`; calls back
    /// with the account, or why it didn't.
    var connectDictate: (_ token: String, _ server: URL, _ done: @escaping (_ account: String?, _ error: String?) -> Void) -> Void = { _, _, done in done(nil, "Not available") }
    /// The finish page redeemed its sign-in ticket: it only asks about Dictate after signing in.
    var signedIn: () -> Void = {}
    /// Settings → This Mac (docs/PLAN-one-settings.md): the app reads or changes its settings and
    /// answers with the snapshot.
    var macSettings: (_ request: MacSettingsBridge.Request, _ reply: @escaping (Any?) -> Void) -> Void = { _, reply in reply(nil) }
    /// The app's own update, for Settings → Apps (docs/PLAN-mac-self-update.md U7).
    var updateState: () -> UpdateState = { .none }
    /// Settings → Apps' "Restart to update".
    var installUpdate: () -> Void = {}
    /// The page is using the microphone (a meeting or clip recording): an update waits (U9).
    var isUsingMicrophone: Bool { webView.microphoneCaptureState == .active || meetingCapture != nil }
    /// The page loaded now said it has This Mac (R11); a new document starts without.
    private var pageSaidHello = false
    /// The same for the Dictate page's "On this Mac" (docs/PLAN-dictations-page.md R7).
    private var pageSaidDictationsHello = false
    /// When the finish page took a sign-in ticket: it may connect Dictate for a short while after.
    private var handoffOpenedAt: Date?
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
    /// Today's weather asks the app for its position (the web view can't ask macOS itself).
    private let location = LocationService()

    init(server: URL?) {
        router = server.map(SuiteRouter.init(server:))
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
        // Settings → Apps reads which version this is (docs/PLAN-mac-version-and-whats-new.md, M4).
        if let versionScript = AppVersion.pageScript(version: AppVersion.current, build: AppVersion.build) {
            configuration.userContentController.addUserScript(WKUserScript(
                source: versionScript, injectionTime: .atDocumentStart, forMainFrameOnly: true
            ))
        }
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
        // /desktop/finish, once signed in, connects Dictate with a token it hands over here (R8).
        configuration.userContentController.addScriptMessageHandler(DictateHandoffHandler(self), contentWorld: .page, name: DictateHandoff.handlerName)
        // Meetings' "Any app on this Mac" (docs/PLAN-record-any-call.md): process taps need 14.2.
        if #available(macOS 14.2, *) {
            configuration.userContentController.addUserScript(WKUserScript(
                source: "window.hearthMac = Object.freeze({ meetingAudio: \(MeetingAudio.bridgeVersion) })", injectionTime: .atDocumentStart, forMainFrameOnly: true
            ))
            configuration.userContentController.addScriptMessageHandler(MeetingAudioHandler(self), contentWorld: .page, name: MeetingAudio.handlerName)
        }
        configuration.userContentController.addScriptMessageHandler(LocationHandler(self), contentWorld: .page, name: LocationBridge.handlerName)
        // Settings → Notifications: macOS's state and a button to its settings (no Notification API here).
        configuration.userContentController.addScriptMessageHandler(NotificationsHandler(self), contentWorld: .page, name: NotificationsBridge.handlerName)
        // Settings → This Mac: the app's own settings, read and changed by the page.
        configuration.userContentController.addScriptMessageHandler(MacSettingsHandler(self), contentWorld: .page, name: MacSettingsBridge.handlerName)
        // Settings → Apps: where the app's own update stands, and "Restart to update".
        configuration.userContentController.addScriptMessageHandler(UpdateHandler(self), contentWorld: .page, name: UpdateBridge.handlerName)
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
        loadHome()
    }

    /// The suite's home, or the window's own page while there's no workspace.
    private func loadHome() {
        if let router {
            webView.load(URLRequest(url: router.server))
        } else {
            stopRetrying()
            webView.loadHTMLString(SuitePages.noWorkspace(), baseURL: nil)
        }
    }

    private func isSuite(_ url: URL) -> Bool { router?.isSuite(url) ?? false }

    /// One of the window's own pages (no workspace, can't reach it), not anything from a server.
    private var isOnOwnPage: Bool {
        guard let current = webView.url else { return true }
        return current.scheme?.lowercased() == "about"
    }

    func show() {
        loadIfNeeded()
        retryNow()
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    /// Another server (Settings): start again there.
    func setServer(_ server: URL) {
        guard server != router?.server else { return }
        router = SuiteRouter(server: server)
        stopRetrying()
        hasLoaded = true
        webView.load(URLRequest(url: server))
    }

    /// Opens a path of the suite (`/meetings/start?event=x`). On a page of the suite already, it
    /// changes route in place, as the web app's own links do, so a recording isn't reloaded.
    func open(path: String) {
        guard let router else { return loadIfNeeded() }
        guard let url = router.url(forPath: path) else { return }
        hasLoaded = true
        if let current = webView.url, isSuite(current), !webView.isLoading {
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
        guard let server = router?.server, let url = BrowserSignIn.finishURL(server: server) else { return }
        pendingTicket = (ticket, Date())
        hasLoaded = true
        webView.load(URLRequest(url: url))
        show()
    }

    /// Hands the pending ticket to the suite's own finish page, once, while it's fresh.
    fileprivate func takeTicket(from message: WKScriptMessage) -> String? {
        guard message.frameInfo.isMainFrame, let page = message.frameInfo.request.url ?? webView.url,
              isSuite(page), page.path == "/desktop/finish",
              let pending = pendingTicket
        else { return nil }
        pendingTicket = nil
        guard Date().timeIntervalSince(pending.received) <= BrowserSignIn.ticketHandoff else { return nil }
        handoffOpenedAt = Date()
        return pending.ticket
    }

    /// Answers the finish page's `hearthDictateConnect`: whether to connect Dictate, then the token.
    /// Only the suite's own finish page, main frame, shortly after it took a ticket; one connect.
    fileprivate func dictateHandoff(_ message: WKScriptMessage, reply: @escaping (Any?) -> Void) {
        guard DictateHandoff.allowed(
                  isMainFrame: message.frameInfo.isMainFrame, isSuiteFrame: isSuiteFrame(message.frameInfo),
                  documentPath: message.frameInfo.request.url?.path, livePath: webView.url?.path,
                  openedAt: handoffOpenedAt, now: Date()
              ),
              let server = router?.server, let request = DictateHandoff.request(message.body)
        else { return reply(nil) }
        switch request {
        case .status:
            // The page asks this only once its ticket signed it in (lib/desktop.ts).
            signedIn()
            let needed = dictateNeeded(server)
            // Nothing to connect: close it now rather than leave it open for the window's length.
            if !needed { handoffOpenedAt = nil }
            reply(["needed": needed, "deviceName": DictateHandoff.deviceName(Host.current().localizedName)])
        case let .connect(token):
            handoffOpenedAt = nil
            connectDictate(token, server) { account, error in
                reply(account.map { ["ok": true, "account": $0] } ?? ["ok": false, "error": error ?? "Couldn’t connect"])
            }
        }
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
        case .followCall(let session):
            guard isOnMeetingsPage else { return nil }
            followedCallSession = session
            return ["ok": true]
        case .openAudioSettings:
            guard isOnMeetingsPage else { return nil }
            Permissions.openAudioCaptureSettings()
            return nil
        case .stop(let session):
            if current?.session == session { stopMeetingCapture() }
            if followedCallSession == session { followedCallSession = nil }
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

    /// Answers Today's `hearthLocation.postMessage('position')`, only for the suite's own page.
    fileprivate func position(for message: WKScriptMessage, reply: @escaping (Any?) -> Void) {
        guard message.frameInfo.isMainFrame, isSuiteFrame(message.frameInfo), LocationBridge.isRequest(message.body) else {
            return reply(nil)
        }
        location.request(reply: reply)
    }

    /// Answers Settings' `hearthNotifications.postMessage('state' | 'open')`, only for the suite's own
    /// page: the state macOS reports, after asking (the first time) or opening System Settings.
    fileprivate func notifications(for message: WKScriptMessage, reply: @escaping (Any?) -> Void) {
        guard message.frameInfo.isMainFrame, isSuiteFrame(message.frameInfo),
              let request = NotificationsBridge.request(message.body)
        else { return reply(nil) }
        Permissions.notificationsState { state in
            guard request == .open else { return reply(state.rawValue) }
            switch NotificationsBridge.step(for: state) {
            case .ask:
                Permissions.requestNotifications { _ in
                    Permissions.notificationsState { reply($0.rawValue) }
                }
            case .openSettings:
                Permissions.openNotificationSettings()
                reply(state.rawValue)
            }
        }
    }

    /// Answers Settings → This Mac's `hotsauceMacSettings.postMessage(...)`, only for the suite's
    /// own page in its main frame (R9). Hello marks this document as having the page (R11).
    fileprivate func answerMacSettings(_ message: WKScriptMessage, reply: @escaping (Any?) -> Void) {
        guard message.frameInfo.isMainFrame, isSuiteFrame(message.frameInfo),
              let request = MacSettingsBridge.parse(message.body)
        else { return reply(nil) }
        if request == .hello {
            pageSaidHello = true
            return reply(nil)
        }
        if request == .helloDictations {
            pageSaidDictationsHello = true
            return reply(nil)
        }
        macSettings(request, reply)
    }

    /// Answers Settings → Apps' `hotsauceMacUpdate.postMessage('state' | 'install')`, only for the
    /// suite's own page in its main frame (U7).
    fileprivate func answerUpdate(_ message: WKScriptMessage, reply: @escaping (Any?) -> Void) {
        guard message.frameInfo.isMainFrame, isSuiteFrame(message.frameInfo),
              let request = UpdateBridge.request(message.body)
        else { return reply(nil) }
        if request == .install { installUpdate() }
        reply(updateState().reply)
    }

    /// Whether ⌘, can show This Mac here, or the app's own small window is needed (R11).
    var settingsDestination: SettingsDestination {
        SettingsDestination.choose(pageSaidHello: pageSaidHello, pageLoaded: isOnSuitePage && failedURL == nil)
    }

    /// Whether "Dictate…" can show the Dictate page's "On this Mac" here, or the old window is
    /// needed (docs/PLAN-dictations-page.md R7).
    var dictationsDestination: SettingsDestination {
        SettingsDestination.choose(pageSaidHello: pageSaidDictationsHello, pageLoaded: isOnSuitePage && failedURL == nil)
    }

    /// Tells the page the history changed, so "On this Mac" reads it again (R5).
    func dictationsChanged() {
        guard pageSaidDictationsHello else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new Event('hotsauce:mac-dictations'))", in: nil, in: .page) { _ in }
    }

    /// The frame's own origin is the suite's, and so is the page the web view shows.
    private func isSuiteFrame(_ frame: WKFrameInfo) -> Bool {
        let origin = frame.securityOrigin
        var components = URLComponents()
        components.scheme = origin.protocol
        components.host = origin.host
        if origin.port != 0 { components.port = origin.port }
        guard let originURL = components.url, isSuite(originURL) else { return false }
        return isOnSuitePage
    }

    private var isOnSuitePage: Bool {
        guard let current = webView.url else { return false }
        return isSuite(current)
    }

    private var isOnMeetingsPage: Bool {
        guard let current = webView.url, isSuite(current) else { return false }
        return MeetingAudio.isMeetingsPath(current.path)
    }

    /// A live meeting started from the call notice in a mode this app doesn't record (mic only,
    /// the Meet tab), by the session its page gave (`follow-call`). Cleared by its `stop` or when
    /// the page goes away.
    private var followedCallSession: String?

    /// The meeting recording in this window (paused counts), by its session: the "Any app on this
    /// Mac" recording, or else a meeting that follows the call. The "Any app" capture doesn't count
    /// while the Start page only checks the sound: nothing is recorded there yet.
    var recordingMeetingSession: String? {
        if #available(macOS 14.2, *), let capture = meetingCapture as? MeetingCapture,
           !(webView.url.map { isSuite($0) && $0.path == "/meetings/start" } ?? false) {
            return capture.session
        }
        return followedCallSession
    }

    /// Tells the recording page its call ended (`CallDetector`), if that recording still runs.
    func meetingCallEnded(session: String) {
        if #available(macOS 14.2, *), let capture = meetingCapture as? MeetingCapture, capture.session == session {
            sendMeetingEvent(MeetingAudio.callEndedEvent(session: session))
        } else if followedCallSession == session {
            sendMeetingEvent(MeetingAudio.callEndedEvent(session: session))
        }
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
        if let failedURL, router != nil {
            retryTimer?.invalidate()
            webView.load(URLRequest(url: failedURL))
        } else if router == nil || isOnOwnPage {
            loadHome()
        } else {
            webView.reload()
        }
    }

    func goBack() { webView.goBack() }
    func goForward() { webView.goForward() }
    func goHome() { loadHome() }
    var canGoBack: Bool { webView.canGoBack }
    var canGoForward: Bool { webView.canGoForward }

    /// GETs a suite API path from inside the signed-in page, with the page's own credentials:
    /// Clerk's session token when there is one, the dev sign-in's header locally, and the session
    /// cookie either way. Nil when the page isn't the suite (signed out, an error page) or the
    /// request fails; the status code otherwise.
    func apiGet(_ path: String) async -> (status: Int, body: Data?)? {
        guard path.hasPrefix("/api/"), let current = webView.url, isSuite(current) else { return nil }
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
        // The window's own pages' "Change workspace address"; a server's page can't ask for it.
        if SuitePages.isChangeWorkspace(url) {
            decisionHandler(.cancel)
            if isOnOwnPage { changeWorkspace() }
            return
        }
        guard let router else {
            // No workspace: only the window's own page loads.
            return decisionHandler(url.scheme?.lowercased() == "about" ? .allow : .cancel)
        }
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
                    if !moved, self.router?.server == server { NSWorkspace.shared.open(url) }
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
        guard let old = router?.server, let health = ServerAddress.healthURL(server: old) else { return false }
        var request = URLRequest(url: health, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        guard let (data, response) = try? await URLSession(configuration: .ephemeral).data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let reported = ServerAddress.reportedOrigin(healthJSON: data),
              ServerAddress.isMove(from: old, to: target, reported: reported),
              router?.server == old
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
        guard let current = webView.url, isSuite(current) else { return }
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
            answeredWithServerError = isSuite(url) && (http?.statusCode ?? 0) >= 500
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
        // A new document: whatever took the sign-in ticket is gone, so is its Dictate handoff.
        if webView.url?.path != DictateHandoff.finishPath { handoffOpenedAt = nil }
        pageSaidHello = false
        pageSaidDictationsHello = false
        stopMeetingCapture()
        followedCallSession = nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        stopMeetingCapture()
        followedCallSession = nil
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
        guard let server = router?.server else { return }
        let failing = (nsError.userInfo[NSURLErrorFailingURLErrorKey] as? URL) ?? server
        let retry = isSuite(failing) ? failing : server
        // Try again by itself: a server restarting for an update is back in seconds, and a Mac
        // that opened the app at login may not be online yet.
        scheduleRetry(of: retry)
        // Names the address it tried, with a way to another one (a mistyped or old address).
        webView.loadHTMLString(SuitePages.cantReach(address: server, reason: nsError.localizedDescription, retry: retry), baseURL: nil)
    }

    // MARK: Windows, panels and permissions the page asks for

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let router, let url = action.request.url, url.absoluteString != "about:blank" else { return nil }
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
        if let url = components.url, isSuite(url) { decisionHandler(.grant) } else { decisionHandler(.prompt) }
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
              isSuite(page)
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

/// Answers /desktop/finish's `hearthDictateConnect.postMessage({type: 'status' | 'connect'})`.
private final class DictateHandoffHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var suite: SuiteWindow?
    init(_ suite: SuiteWindow) { self.suite = suite }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping @MainActor (Any?, String?) -> Void) {
        MainActor.assumeIsolated {
            guard let suite else { return replyHandler(nil, nil) }
            suite.dictateHandoff(message) { answer in
                MainActor.assumeIsolated { replyHandler(answer, nil) }
            }
        }
    }
}

/// Answers Today's `hearthLocation.postMessage('position')` (`LocationService`).
private final class LocationHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var suite: SuiteWindow?
    init(_ suite: SuiteWindow) { self.suite = suite }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping @MainActor (Any?, String?) -> Void) {
        MainActor.assumeIsolated {
            guard let suite else { return replyHandler(nil, nil) }
            suite.position(for: message) { answer in replyHandler(answer, nil) }
        }
    }
}

private final class NotificationsHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var suite: SuiteWindow?
    init(_ suite: SuiteWindow) { self.suite = suite }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping @MainActor (Any?, String?) -> Void) {
        MainActor.assumeIsolated {
            guard let suite else { return replyHandler(nil, nil) }
            suite.notifications(for: message) { answer in
                MainActor.assumeIsolated { replyHandler(answer, nil) }
            }
        }
    }
}

/// Answers Settings → This Mac's `hotsauceMacSettings.postMessage({type: ...})`.
private final class MacSettingsHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var suite: SuiteWindow?
    init(_ suite: SuiteWindow) { self.suite = suite }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping @MainActor (Any?, String?) -> Void) {
        MainActor.assumeIsolated {
            guard let suite else { return replyHandler(nil, nil) }
            suite.answerMacSettings(message) { answer in
                MainActor.assumeIsolated { replyHandler(answer, nil) }
            }
        }
    }
}

/// Answers Settings → Apps' `hotsauceMacUpdate.postMessage(...)`.
private final class UpdateHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var suite: SuiteWindow?
    init(_ suite: SuiteWindow) { self.suite = suite }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping @MainActor (Any?, String?) -> Void) {
        MainActor.assumeIsolated {
            guard let suite else { return replyHandler(nil, nil) }
            suite.answerUpdate(message) { answer in
                MainActor.assumeIsolated { replyHandler(answer, nil) }
            }
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
