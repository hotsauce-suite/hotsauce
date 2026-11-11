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
