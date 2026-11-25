import Foundation

/// One "also heard as" spelling and the word it is written as
/// (docs/PLAN-dictate-punctuation-and-fixes.md, H6).
public struct WordFix: Codable, Equatable, Sendable {
    public var heard: String
    public var write: String

    public init(heard: String, write: String) {
        self.heard = heard
        self.write = write
    }
}

/// The member's heard-as spellings, kept on this Mac so a dictation written up without the
/// server still spells "Rajeev" as "Rajiv". The server applies the same list to everything it
/// writes; applying it again changes nothing.
public enum WordFixes {
    static let key = "dictateWordFixes"

    /// Each heard spelling written as its word: whole words, any capitals, longest first, in
    /// one pass so a fix never feeds another. Matches `applyFixes` on the server.
    public static func apply(_ text: String, _ fixes: [WordFix]) -> String {
        guard !fixes.isEmpty, !text.isEmpty else { return text }
        var byKey: [String: String] = [:]
        for fix in fixes {
            let key = normalized(fix.heard)
            if !key.isEmpty, byKey[key] == nil { byKey[key] = fix.write }
        }
        guard !byKey.isEmpty else { return text }
        let alternatives = byKey.keys
            .sorted { $0.count > $1.count }
            .map { NSRegularExpression.escapedPattern(for: $0).replacingOccurrences(of: " ", with: "\\s+") }
        let pattern = "(?<![\\p{L}\\p{N}])(\(alternatives.joined(separator: "|")))(?![\\p{L}\\p{N}])"
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return text }
        let source = text as NSString
        var out = ""
        var last = 0
        for match in regex.matches(in: text, range: NSRange(location: 0, length: source.length)) {
            out += source.substring(with: NSRange(location: last, length: match.range.location - last))
            let found = source.substring(with: match.range)
            out += byKey[normalized(found)] ?? found
            last = match.range.location + match.range.length
        }
        out += source.substring(from: last)
        return out
    }

    static func normalized(_ s: String) -> String {
        s.split(whereSeparator: \.isWhitespace).joined(separator: " ").lowercased()
    }

    public static func cached(_ defaults: UserDefaults = .standard) -> [WordFix] {
        guard let data = defaults.data(forKey: key) else { return [] }
        return (try? JSONDecoder().decode([WordFix].self, from: data)) ?? []
    }

    public static func save(_ fixes: [WordFix], in defaults: UserDefaults = .standard) {
        if let data = try? JSONEncoder().encode(fixes) { defaults.set(data, forKey: key) }
    }

    /// Another account's spellings aren't this one's.
    public static func forget(_ defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: key)
    }
}
