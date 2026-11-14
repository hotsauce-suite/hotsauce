import Foundation

/// The window's own pages, for when it can't show the suite: no workspace yet, or the workspace
/// didn't answer. Local HTML, nothing loaded from the network (docs/PLAN-mac-onboarding.md R1, R6).
public enum SuitePages {
    /// The pages' "Change workspace address" link. The window cancels it and opens the setup
    /// window's Workspace step; it only does that while one of these pages is showing.
    public static let changeWorkspaceURL = URL(string: "x-suite-window:change-workspace")!

    public static func isChangeWorkspace(_ url: URL) -> Bool {
        url.absoluteString == changeWorkspaceURL.absoluteString
    }

    /// The workspace didn't answer: which address, why, and two ways on.
    public static func cantReach(address: URL, reason: String, retry: URL) -> String {
        let host = address.host ?? address.absoluteString
        return page("""
        <h1>Can’t reach \(escape(Brand.name))</h1>
        <p>Tried <strong>\(escape(host))</strong>. \(escape(reason)) Trying again by itself…</p>
        <a class="button" href="\(escape(retry.absoluteString))">Try again</a>
        <a class="link" href="\(escape(changeWorkspaceURL.absoluteString))">Change workspace address</a>
        """)
    }

    /// No workspace yet (a fresh Mac): nothing to load until the member names one.
    public static func noWorkspace() -> String {
        page("""
        <h1>Which workspace?</h1>
        <p>Enter your team’s \(escape(Brand.name)) address in the setup window to get started.</p>
        <a class="button" href="\(escape(changeWorkspaceURL.absoluteString))">Enter workspace address</a>
        """)
    }

    private static func page(_ body: String) -> String {
        """
        <!doctype html><meta charset="utf-8"><title>\(escape(Brand.name))</title>
        <style>
        :root { color-scheme: light dark; --ink: #2A221D; --soft: #5B4E44; --paper: #F2EADF; --accent: #\(hex(Brand.accentLight)); }
        @media (prefers-color-scheme: dark) { :root { --ink: #EDE3D6; --soft: #C1B2A2; --paper: #1D1815; --accent: #\(hex(Brand.accentDark)); } }
        body { font: 14px -apple-system, system-ui; background: var(--paper); color: var(--ink); display: grid; place-items: center; height: 100vh; margin: 0; }
        h1 { font: 600 22px ui-serif, Georgia, serif; margin: 0 0 8px; }
        p { color: var(--soft); margin: 0 0 20px; max-width: 420px; }
        strong { color: var(--ink); font-weight: 600; }
        a.button { color: white; background: var(--accent); padding: 8px 16px; border-radius: 8px; text-decoration: none; font-weight: 600; }
        a.link { color: var(--accent); margin-left: 16px; text-decoration: none; font-weight: 600; }
        </style>
        <div>\(body)</div>
        """
    }

    private static func hex(_ value: UInt32) -> String { String(format: "%06X", value) }

    static func escape(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
    }
}
