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

    /// Where Save Link goes: the save page with the copied link when the clipboard holds one (the
    /// Mac reads it itself; the page still asks before saving), else the page's Paste and save.
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

    /// The first http(s) address in some text, without trailing punctuation, or a bare
    /// `example.com/page` as https (the web app's findLinkUrl does the same).
    static func firstLink(in text: String) -> String? {
        if let range = text.range(of: #"https?://[^\s<>"']+"#, options: [.regularExpression, .caseInsensitive]) {
            var link = String(text[range])
            while let last = link.last, ").,;:!?]}'\"".contains(last) { link.removeLast() }
            return link
        }
        let bare = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if bare.range(of: #"^[a-z0-9-]+(\.[a-z0-9-]+)+(/\S*)?$"#, options: [.regularExpression, .caseInsensitive]) != nil,
           bare.range(of: #"\.[a-z]{2,}(/|$)"#, options: [.regularExpression, .caseInsensitive]) != nil {
            return "https://\(bare)"
        }
        return nil
    }

    private static let queryValue: CharacterSet = {
        // ASCII only: CharacterSet.alphanumerics would let accented letters through unencoded.
        CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
    }()
}
