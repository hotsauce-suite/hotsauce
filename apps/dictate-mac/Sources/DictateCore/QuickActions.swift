import Foundation

/// The quick actions in the Dock icon's menu and the menu bar menu, the Mac's version of holding
/// the app's icon on a phone (docs/PLAN-phone-shortcuts.md). The web app has the same list in
/// apps/web/src/lib/phoneShortcuts.ts; apps/web/src/lib/phoneShortcuts.test.ts keeps the
/// addresses in step. Voice notes stay out: on a Mac, Dictate and Meetings do that job.
public enum QuickActions {
    public static let all: [(title: String, path: String)] = [
        ("New Task", "/tasks?new=1"),
        ("Save Link", "/links/save?paste=1"),
        ("Ask", "/today?ask=1"),
        ("Ramble Tasks", "/tasks?ramble=1"),
    ]

    /// Where Save Link goes: straight to saving the copied link when the clipboard holds one
    /// (the Mac reads it itself, so the page needn't ask), else the page's Paste and save.
    public static func saveLinkPath(clipboard: String?) -> String {
        guard let link = firstLink(in: clipboard ?? "") else { return "/links/save?paste=1" }
        var parts = URLComponents()
        parts.path = "/links/save"
        parts.queryItems = [URLQueryItem(name: "via", value: "shortcut"), URLQueryItem(name: "url", value: link)]
        // URLComponents leaves & and + in a value alone; the page reads them as separators.
        let query = parts.queryItems!.map { item in
            "\(item.name)=\(item.value!.addingPercentEncoding(withAllowedCharacters: queryValue) ?? "")"
        }.joined(separator: "&")
        return "/links/save?\(query)"
    }

    /// The first http(s) address in some text, without trailing punctuation.
    static func firstLink(in text: String) -> String? {
        guard let range = text.range(of: #"https?://[^\s<>"']+"#, options: [.regularExpression, .caseInsensitive]) else { return nil }
        var link = String(text[range])
        while let last = link.last, ").,;:!?]}'\"".contains(last) { link.removeLast() }
        return link
    }

    private static let queryValue: CharacterSet = {
        var set = CharacterSet.alphanumerics
        set.insert(charactersIn: "-._~")
        return set
    }()
}
