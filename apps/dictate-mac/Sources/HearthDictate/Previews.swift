import AppKit
import DictateCore
import SwiftUI
import WebKit

/// `HearthDictate --render-previews <folder> [--dark]`: draws each page of the main window, with
/// made-up history held only in memory, to PNGs, for checking the design without screen access.
@MainActor
enum Previews {
    static func render(to folder: String, dark: Bool) -> Int32 {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        app.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        let model = sampleModel()
        for page in MainModel.Page.allCases {
            model.page = page
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 980, height: 700), styleMask: [.titled, .fullSizeContentView], backing: .buffered, defer: false)
            window.titlebarAppearsTransparent = true
            window.appearance = app.appearance
            let view = NSHostingView(rootView: MainView(model: model))
            window.contentView = view
            window.layoutIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.6))
            guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return 1 }
            view.cacheDisplay(in: view.bounds, to: rep)
            let url = URL(fileURLWithPath: folder).appendingPathComponent("\(page.rawValue.lowercased())\(dark ? "-dark" : "").png")
            try? rep.representation(using: .png, properties: [:])?.write(to: url)
            window.close()
        }
        renderSetup(to: folder, dark: dark)
        renderPages(to: folder, dark: dark)
        return 0
    }

    /// The setup window's Workspace step: empty, an address that isn't a workspace, and one found.
    private static func renderSetup(to folder: String, dark: Bool) {
        let server = URL(string: "https://team.example.com")!
        let states: [(String, (OnboardingModel) -> Void)] = [
            ("workspace-empty", { _ in }),
            ("workspace-error", { model in
                model.workspaceText = "www.example.com"
                model.workspaceError = Workspace.CheckResult.notHotsauce.message(for: URL(string: "https://www.example.com")!)
            }),
            ("workspace-found", { model in
                model.workspace = { server }
                model.editingWorkspace = false
                model.workspaceText = "team.example.com"
                model.workspaceFound = "Acme. Sign in with your example.com Google account."
                model.offerSignIn = true
            }),
        ]
        for (name, configure) in states {
            let model = OnboardingModel()
            model.workspace = { nil }
            model.editingWorkspace = true
            configure(model)
            snapshot(OnboardingWindow.previewView(model: model), size: NSSize(width: 500, height: 720),
                     to: URL(fileURLWithPath: folder).appendingPathComponent("\(name)\(dark ? "-dark" : "").png"), dark: dark)
        }
    }

    /// The window's own pages: no workspace yet, and Can't reach with Change workspace address.
    private static func renderPages(to folder: String, dark: Bool) {
        let server = URL(string: "https://team.example.com")!
        let pages = [
            ("page-no-workspace", SuitePages.noWorkspace()),
            ("page-cant-reach", SuitePages.cantReach(address: server, reason: "A server with the specified hostname could not be found.", retry: server)),
        ]
        for (name, html) in pages {
            let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 900, height: 560))
            webView.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            let window = NSWindow(contentRect: webView.frame, styleMask: [.titled], backing: .buffered, defer: false)
            window.appearance = webView.appearance
            window.contentView = webView
            webView.loadHTMLString(html, baseURL: nil)
            let deadline = Date().addingTimeInterval(5)
            while webView.isLoading && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.1)) }
            RunLoop.main.run(until: Date().addingTimeInterval(0.5))
            var image: NSImage?
            webView.takeSnapshot(with: nil) { snap, _ in image = snap }
            let wait = Date().addingTimeInterval(5)
            while image == nil && Date() < wait { RunLoop.main.run(until: Date().addingTimeInterval(0.1)) }
            if let tiff = image?.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) {
                try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name)\(dark ? "-dark" : "").png"))
            }
            window.close()
        }
    }

    private static func snapshot(_ view: NSView, size: NSSize, to url: URL, dark: Bool) {
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.contentView = view
        window.layoutIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.6))
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: url)
        window.close()
    }

    private static func sampleModel() -> MainModel {
        let model = MainModel()
        let now = Date()
        let samples: [(String, String, String, Double, Int)] = [
            ("Slack", "com.tinyspeck.slackmacgap", "Can we push the Acme report review to Wednesday? I want Dana to see the SSO section first", 0.02, 7_200),
            ("Mail", "com.apple.mail", "Hi Priya,\n\nThanks for the call today. As discussed, we’ll send the pilot agreement by Friday and schedule onboarding for the week after.\n\nBest,\nAda", 0.3, 16_500),
            ("Cursor", "com.todesktop.230313mzl4w4u92", "add a retry with exponential backoff around the deepgram request and log only the status code", 1.1, 6_100),
            ("Slack", "com.tinyspeck.slackmacgap", "Shipping Dictate to the team today 🎉", 2.4, 3_000),
            ("Notes", "com.apple.Notes", "- Call the lab about sample intake\n- Draft the Q1 hiring plan\n- Review Granola notes from Monday", 3.2, 9_800),
            ("Messages", "com.apple.MobileSMS", "Running ten minutes late, start without me", 5.5, 2_600),
            ("Mail", "com.apple.mail", "Following up on the Acme biosafety audit: the report is attached and the open items are on page four.", 8.0, 8_900),
            ("Slack", "com.tinyspeck.slackmacgap", "Morning all, standup notes are in Hearth under meetings", 12.0, 4_400),
            ("Ghostty", "com.mitchellh.ghostty", "git log --oneline -20", 15.0, 2_000),
            ("Slack", "com.tinyspeck.slackmacgap", "Love it. Let’s do that", 21.0, 1_900),
        ]
        model.records = samples.map { app, bundle, text, days, ms in
            DictationRecord(date: now.addingTimeInterval(-days * 86_400), text: text, cleaned: app != "Ghostty", appName: app, appBundle: bundle, audioMs: ms)
        }
        model.mine = ["Priya", "Kestrel", "Fly.io"]
        model.team = ["Acme", "Hearth", "Ember", "Granola", "Clerk", "Deepgram", "Anthropic", "Claude"]
        model.wordsState = nil
        model.microphone = true
        model.accessibility = true
        model.listening = true
        model.account = "ada@example.com"
        model.server = "https://office.example.com"
        return model
    }
}
