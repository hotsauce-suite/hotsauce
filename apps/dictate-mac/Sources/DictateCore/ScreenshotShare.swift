import Foundation

/// Share (docs/PLAN-screenshots.md R14): the app hands the flattened picture to the signed-in
/// page in its window, `window.hotsauceMac.shareScreenshot(name, pngBase64)`
/// (apps/web/src/lib/macScreenshots.ts), and copies the link it answers with. Pure: reading the
/// answer and wording what to tell the person, tested without a page.
public enum ScreenshotShare {
    /// The page refuses anything larger (MAX_SCREENSHOT_BYTES).
    public static let maxBytes = 25 * 1024 * 1024

    public enum Failure: Error, Equatable, Sendable {
        /// No page, no function, or nobody signed in.
        case notSignedIn
        case tooLarge
        /// The page's own words.
        case page(String)
    }

    public enum Outcome: Equatable, Sendable {
        case shared(url: URL, anyone: Bool, deleteAfter: Date?)
        case failed(Failure)
    }

    /// What the app sends: the picture as base64, or why it can't go.
    public static func payload(_ png: Data) -> Result<String, Failure> {
        png.count > maxBytes ? .failure(.tooLarge) : .success(png.base64EncodedString())
    }

    /// Runs in the page with `name` and `png`: the function's answer, or `{missing: true}` when
    /// the page hasn't put it there (an older web app, or no page).
    public static let script = """
    const share = window.hotsauceMac && window.hotsauceMac.shareScreenshot;
    if (typeof share !== 'function') return { missing: true };
    return await share(name, png);
    """

    /// The page's answer, checked. Anything malformed is a plain failure, never a link.
    public static func parse(_ answer: Any?, expectedHost: String? = nil) -> Outcome {
        guard let answer = answer as? [String: Any] else { return .failed(.notSignedIn) }
        if answer["missing"] as? Bool == true { return .failed(.notSignedIn) }
        if isTrue(answer["ok"]) {
            guard let text = answer["url"] as? String, let url = URL(string: text),
                  url.scheme == "https" || url.scheme == "http", url.host?.isEmpty == false,
                  expectedHost.map({ url.host?.lowercased() == $0.lowercased() }) ?? true
            else { return .failed(.page("The link Hotsauce sent back didn’t work.")) }
            let anyone = isTrue(answer["anyone"])
            let deleteAfter = (answer["deleteAfter"] as? String).flatMap(date(from:))
            return .shared(url: url, anyone: anyone, deleteAfter: deleteAfter)
        }
        let error = (answer["error"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if error.isEmpty { return .failed(.page("Couldn’t share the screenshot.")) }
        if error.lowercased().hasPrefix("sign in") { return .failed(.notSignedIn) }
        if error.lowercased().contains("too large") { return .failed(.tooLarge) }
        return .failed(.page(error))
    }

    /// What to tell the person, in plain words.
    public static func message(_ outcome: Outcome, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        switch outcome {
        case let .shared(_, anyone, deleteAfter):
            guard anyone else {
                return "Link copied. Only signed-in members can open it (public links are off for this organization)."
            }
            guard let deleteAfter else { return "Link copied. Anyone with the link can open it." }
            return "Link copied. Anyone with the link can open it until \(plainDate(deleteAfter, locale: locale, timeZone: timeZone))."
        case .failed(.notSignedIn):
            return "Open Hotsauce and sign in, then press Share again."
        case .failed(.tooLarge):
            return "This screenshot is too large to share."
        case let .failed(.page(error)):
            return error
        }
    }

    /// "19 December 2026" or "December 19, 2026", as the Mac is set.
    public static func plainDate(_ date: Date, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = timeZone
        formatter.dateStyle = .long
        formatter.timeStyle = .none
        return formatter.string(from: date)
    }

    static func date(from text: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }

    /// A JavaScript `true` (WebKit hands booleans over as NSNumber).
    private static func isTrue(_ value: Any?) -> Bool {
        guard let number = value as? NSNumber else { return false }
        return CFGetTypeID(number) == CFBooleanGetTypeID() && number.boolValue
    }
}

extension ScreenshotShortcut {
    /// Why a chord can't be the screenshot shortcut, or nil when it can.
    public var refusal: String? {
        guard Self.keyNames[keyCode] != nil else { return "That key can’t be part of a shortcut." }
        if modifiers.intersection([.command, .option, .control]).isEmpty {
            return "Add ⌘, ⌥ or ⌃, so the shortcut doesn’t get in the way of typing."
        }
        if modifiers == [.command] {
            return "⌘ on its own would take over app shortcuts like ⌘C. Add ⌥, ⌃ or ⇧."
        }
        // ⇧⌘3, ⇧⌘4, ⇧⌘5 and ⇧⌘6 are macOS's own screenshot keys.
        if modifiers == [.command, .shift], [20, 21, 23, 22].contains(keyCode) {
            return "macOS uses \(display) for its own screenshots. Pick another."
        }
        return nil
    }
}

/// What happens after a capture, and where shots go (Settings → This Mac → Screenshots, R15).
public struct ScreenshotAfterCapture: Equatable, Sendable {
    public var copy: Bool
    public var save: Bool
    public var preview: Bool

    public init(copy: Bool = true, save: Bool = true, preview: Bool = true) {
        self.copy = copy
        self.save = save
        self.preview = preview
    }

    static let copyKey = "screenshotCopy"
    static let saveKey = "screenshotSave"
    static let previewKey = "screenshotPreview"

    public static func load(_ defaults: UserDefaults) -> ScreenshotAfterCapture {
        ScreenshotAfterCapture(
            copy: defaults.object(forKey: copyKey) as? Bool ?? true,
            save: defaults.object(forKey: saveKey) as? Bool ?? true,
            preview: defaults.object(forKey: previewKey) as? Bool ?? true
        )
    }

    public func store(in defaults: UserDefaults) {
        defaults.set(copy, forKey: Self.copyKey)
        defaults.set(save, forKey: Self.saveKey)
        defaults.set(preview, forKey: Self.previewKey)
    }
}
