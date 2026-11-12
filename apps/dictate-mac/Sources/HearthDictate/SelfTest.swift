import AppKit
import DictateCore
import UserNotifications
import WebKit

/// `HearthDictate --self-test <server> <folder> [--sign-in-dev <email>] [--remind]`: drives the
/// app's real suite window against a server and writes what it saw (`result.json`) and snapshots
/// of the page (PNG) to the folder, for automated end-to-end checks of the window: loading,
/// storage that survives a relaunch, in-place route changes, the reminders' API call, and (with
/// `--remind`) posting a reminder notification. Run it from the installed app with the app quit.
@MainActor
enum SelfTest {
    static func run(arguments: [String]) -> Int32 {
        guard let index = arguments.firstIndex(of: "--self-test"), index + 2 < arguments.count,
              let server = ConnectLink.normalizedServer(arguments[index + 1])
        else {
            FileHandle.standardError.write(Data("usage: --self-test <server> <folder> [--sign-in-dev <email>] [--remind]\n".utf8))
            return 2
        }
        let folder = URL(fileURLWithPath: arguments[index + 2])
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let devEmail = arguments.firstIndex(of: "--sign-in-dev").flatMap { $0 + 1 < arguments.count ? arguments[$0 + 1] : nil }
        let remind = arguments.contains("--remind")

        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let suite = SuiteWindow(server: server)
        var result: [String: Any] = ["server": server.absoluteString]
        var code: Int32 = 1

        Task { @MainActor in
            defer { app.stop(nil); app.postEvent(NSEvent.otherEvent(with: .applicationDefined, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, subtype: 0, data1: 0, data2: 0)!, atStart: true) }
            // Loading pages must never start a browser sign-in on its own (a Clerk redirect would).
            var browserSignIns = 0
            suite.signInWithBrowser = { browserSignIns += 1 }
            // On screen: WebKit doesn't paint a page in a window that isn't.
            suite.show()
            await waitForLoad(suite.webView)
            result["userAgent"] = (try? await suite.webView.evaluateJavaScript("navigator.userAgent")) as? String
            // What the last run left: storage and a cookie that must survive a relaunch.
            result["storedBefore"] = (try? await suite.webView.evaluateJavaScript("localStorage.getItem('hearth.selfTest')")) as? String ?? NSNull()
            result["cookieBefore"] = (try? await suite.webView.evaluateJavaScript("document.cookie.includes('hearthSelfTest=1')")) as? Bool ?? false
            result["devUserBefore"] = (try? await suite.webView.evaluateJavaScript("localStorage.getItem('hearth.devUser')")) as? String ?? NSNull()
            let stamp = ISO8601DateFormatter().string(from: Date())
            _ = try? await suite.webView.evaluateJavaScript("localStorage.setItem('hearth.selfTest', '\(stamp)'); document.cookie = 'hearthSelfTest=1; max-age=86400; path=/'")
            if let devEmail {
                _ = try? await suite.webView.callAsyncJavaScript("localStorage.setItem('hearth.devUser', email)", arguments: ["email": devEmail], in: nil, contentWorld: .page)
                suite.reload()
                await waitForLoad(suite.webView)
            }
            try? await Task.sleep(for: .seconds(2))
            await snapshot(suite.webView, to: folder.appendingPathComponent("1-home.png"))
            result["homeURL"] = suite.webView.url?.absoluteString
            result["homeTitle"] = suite.webView.title

            // A rail shortcut: the route changes in place, without a new page load.
            _ = try? await suite.webView.evaluateJavaScript("window.__selfTestMarker = 42")
            suite.open(path: "/meetings")
            try? await Task.sleep(for: .seconds(3))
            result["afterOpenURL"] = suite.webView.url?.absoluteString
            result["openKeptPage"] = (try? await suite.webView.evaluateJavaScript("window.__selfTestMarker === 42")) as? Bool ?? false
            await snapshot(suite.webView, to: folder.appendingPathComponent("2-meetings.png"))

            // The reminders' call, through the page's own sign-in.
            let now = Date()
            let format = ISO8601DateFormatter()
            let api = await suite.apiGet("/api/calendar/upcoming?from=\(format.string(from: now))&to=\(format.string(from: now.addingTimeInterval(ReminderPlanner.lookahead)))")
            result["upcomingStatus"] = api?.status ?? NSNull()
            if let body = api?.body, let meetings = try? UpcomingMeeting.decodeList(body) {
                var planner = ReminderPlanner()
                // The fake calendar's meeting starts within two minutes: as a later pass would see it.
                let due = planner.due(meetings, now: meetings.first.map { $0.start.addingTimeInterval(-60) } ?? now)
                result["upcoming"] = meetings.map { ["id": $0.id, "title": $0.title, "start": format.string(from: $0.start)] }
                result["due"] = due.map(\.id)
                if remind, let meeting = due.first {
                    result["notification"] = await postReminder(meeting)
                }
                if let meeting = due.first {
                    suite.open(path: meeting.startPath)
                    try? await Task.sleep(for: .seconds(3))
                    result["reminderClickURL"] = suite.webView.url?.absoluteString
                    await snapshot(suite.webView, to: folder.appendingPathComponent("3-reminder-start.png"))
                }
            }

            // A deep link, as the app's URL handler resolves it.
            if let path = SuiteRouter.deepLinkPath(URL(string: "\(Brand.urlScheme)://clips")!) {
                suite.open(path: path)
                try? await Task.sleep(for: .seconds(3))
                result["deepLinkURL"] = suite.webView.url?.absoluteString
                await snapshot(suite.webView, to: folder.appendingPathComponent("4-deep-link-clips.png"))
            }
            // Signing in through "the browser": a second web view with its own storage plays the
            // browser, already signed in; its confirm page hands the ticket back on hearth://.
            if let email = arguments.firstIndex(of: "--browser-sign-in").flatMap({ $0 + 1 < arguments.count ? arguments[$0 + 1] : nil }) {
                result["browserSignIn"] = await browserSignIn(suite: suite, email: email, folder: folder)
            }

            // A download link, as Clips' Download button: the app's bridge saves it to ~/Downloads.
            if arguments.contains("--download") {
                var finished: String?
                suite.showMessage = { finished = $0 }
                suite.open(path: "/docs")
                try? await Task.sleep(for: .seconds(2))
                _ = try? await suite.webView.evaluateJavaScript("""
                const a = document.createElement('a'); a.href = '/api/health'; a.download = 'self-test.json';
                document.body.appendChild(a); a.click(); a.remove()
                """)
                for _ in 0 ..< 20 where finished == nil { try? await Task.sleep(for: .milliseconds(250)) }
                result["download"] = finished ?? "nothing finished"
            }

            // Signed out on a real server: press "Continue with Google" and see what Google says.
            if arguments.contains("--try-google") {
                suite.goHome()
                await waitForLoad(suite.webView)
                try? await Task.sleep(for: .seconds(3))
                await snapshot(suite.webView, to: folder.appendingPathComponent("5-sign-in.png"))
                for _ in 0 ..< 10 where suite.webView.url.map(suite.router.isSuite) ?? true {
                    _ = try? await suite.webView.evaluateJavaScript("[...document.querySelectorAll('button')].find((b) => /google/i.test(b.textContent))?.click()")
                    try? await Task.sleep(for: .seconds(3))
                }
                await waitForLoad(suite.webView)
                result["googleURL"] = suite.webView.url?.host
                result["googleText"] = ((try? await suite.webView.evaluateJavaScript("document.body.innerText.slice(0, 300)")) as? String)
                await snapshot(suite.webView, to: folder.appendingPathComponent("6-google.png"))
            }
            result["browserSignInsWhileBrowsing"] = browserSignIns
            result["mediaDevices"] = (try? await suite.webView.evaluateJavaScript(
                "JSON.stringify({ getUserMedia: typeof navigator.mediaDevices?.getUserMedia, getDisplayMedia: typeof navigator.mediaDevices?.getDisplayMedia, documentPiP: 'documentPictureInPicture' in window })"
            )) as? String

            if let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]) {
                try? data.write(to: folder.appendingPathComponent("result.json"))
                print(String(decoding: data, as: UTF8.self))
            }
            code = 0
        }
        app.run()
        return code
    }

    /// Signs the window out, presses "Sign in with your browser" on its sign-in page, confirms in
    /// a separate "browser" web view, and checks the window ends up signed in.
    private static func browserSignIn(suite: SuiteWindow, email: String, folder: URL) async -> [String: Any] {
        var out: [String: Any] = [:]
        _ = try? await suite.webView.evaluateJavaScript("localStorage.removeItem('hearth.devUser')")
        // A link straight to the finish page (a doc, another site) must sign nothing in, even
        // with a ticket in it; deep links to it are refused outright.
        out["deepLinkToFinishRefused"] = suite.router.url(forPath: SuiteRouter.deepLinkPath(URL(string: "hearth://desktop/finish#ticket=dev:eve@acmebiolab.com")!) ?? "") == nil
        suite.webView.load(URLRequest(url: URL(string: "\(suite.router.server.absoluteString)/desktop/finish#ticket=dev:eve@acmebiolab.com")!))
        await waitForLoad(suite.webView)
        try? await Task.sleep(for: .seconds(2))
        out["directFinishSignedInAs"] = (try? await suite.webView.evaluateJavaScript("localStorage.getItem('hearth.devUser')")) as? String ?? NSNull()
        out["directFinishText"] = (try? await suite.webView.evaluateJavaScript("document.body.innerText.slice(0, 120)")) as? String

        suite.webView.load(URLRequest(url: URL(string: "\(suite.router.server.absoluteString)/sign-in")!))
        await waitForLoad(suite.webView)
        try? await Task.sleep(for: .seconds(1))
        out["windowSignInText"] = (try? await suite.webView.evaluateJavaScript("document.body.innerText.slice(0, 200)")) as? String
        await snapshot(suite.webView, to: folder.appendingPathComponent("7-sign-in-in-app.png"))

        // What the app does on the button: a new state, the connect page in "the browser".
        var started: BrowserSignIn?
        var openedURL: URL?
        suite.signInWithBrowser = {
            let signIn = BrowserSignIn()
            started = signIn
            openedURL = signIn.connectURL(server: suite.router.server)
        }
        _ = try? await suite.webView.evaluateJavaScript("[...document.querySelectorAll('button')].find((b) => /browser/i.test(b.textContent))?.click()")
        try? await Task.sleep(for: .seconds(1))
        guard let signIn = started, let connect = openedURL else {
            out["error"] = "the sign-in page didn't ask the app to sign in with the browser"
            return out
        }
        out["connectURL"] = connect.absoluteString

        let browser = FakeBrowser()
        await browser.load(URL(string: "\(suite.router.server.absoluteString)/sign-in")!)
        _ = try? await browser.webView.callAsyncJavaScript("localStorage.setItem('hearth.devUser', email)", arguments: ["email": email], in: nil, contentWorld: .page)
        await browser.load(connect)
        try? await Task.sleep(for: .seconds(2))
        out["browserText"] = (try? await browser.webView.evaluateJavaScript("document.body.innerText.slice(0, 200)")) as? String
        await snapshot(browser.webView, to: folder.appendingPathComponent("8-browser-confirm.png"))
        _ = try? await browser.webView.evaluateJavaScript("[...document.querySelectorAll('button')].find((b) => /Mac app/.test(b.textContent))?.click()")
        for _ in 0 ..< 40 where browser.callback == nil { try? await Task.sleep(for: .milliseconds(250)) }
        guard let callback = browser.callback else {
            out["error"] = "the browser never handed a ticket back"
            return out
        }
        out["callbackHasTicket"] = callback.absoluteString.contains("ticket=")
        // A callback with another state (any web page could send one) is refused.
        out["forgedStateRefused"] = signIn.ticket(from: URL(string: "hearth://auth/callback?state=forged&ticket=x")!) == nil
        guard let ticket = signIn.ticket(from: callback) else {
            out["error"] = "the app refused its own callback"
            return out
        }
        suite.finishSignIn(ticket: ticket)
        await waitForLoad(suite.webView)
        try? await Task.sleep(for: .seconds(2))
        out["windowURLAfter"] = suite.webView.url?.absoluteString
        out["windowSignedInAs"] = (try? await suite.webView.evaluateJavaScript("localStorage.getItem('hearth.devUser')")) as? String ?? NSNull()
        await snapshot(suite.webView, to: folder.appendingPathComponent("9-signed-in-after-browser.png"))
        return out
    }

    private static func waitForLoad(_ webView: WKWebView) async {
        try? await Task.sleep(for: .milliseconds(500))
        for _ in 0 ..< 60 where webView.isLoading { try? await Task.sleep(for: .milliseconds(250)) }
        try? await Task.sleep(for: .seconds(1))
    }

    private static func snapshot(_ webView: WKWebView, to url: URL) async {
        guard let image = try? await webView.takeSnapshot(configuration: nil),
              let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:])
        else { return }
        try? png.write(to: url)
    }

    private static func postReminder(_ meeting: UpcomingMeeting) async -> String {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else {
            return "not authorized (\(settings.authorizationStatus.rawValue))"
        }
        let content = UNMutableNotificationContent()
        content.title = "Take notes for “\(meeting.title)”?"
        content.body = "It starts in about a minute."
        content.userInfo = ["path": meeting.startPath]
        do {
            try await center.add(UNNotificationRequest(identifier: "self-test \(meeting.id)", content: content, trigger: nil))
            try? await Task.sleep(for: .seconds(1))
            let delivered = await center.deliveredNotifications()
            return delivered.contains { $0.request.identifier == "self-test \(meeting.id)" } ? "delivered" : "added, not listed as delivered"
        } catch {
            return "failed: \(error.localizedDescription)"
        }
    }
}

/// Plays the member's browser in `--self-test`: its own storage, and it records the app link the
/// confirm page opens instead of opening it.
@MainActor
private final class FakeBrowser: NSObject, WKNavigationDelegate {
    let webView: WKWebView
    var callback: URL?

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 900, height: 700), configuration: configuration)
        super.init()
        webView.navigationDelegate = self
        let window = NSWindow(contentRect: NSRect(x: 40, y: 40, width: 900, height: 700), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = webView
        window.orderFront(nil)
    }

    func load(_ url: URL) async {
        webView.load(URLRequest(url: url))
        try? await Task.sleep(for: .milliseconds(500))
        for _ in 0 ..< 60 where webView.isLoading { try? await Task.sleep(for: .milliseconds(250)) }
        try? await Task.sleep(for: .seconds(1))
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, url.scheme == Brand.urlScheme {
            callback = url
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }
}
