import Foundation

/// The last few dictations' text, newest first. Kept in UserDefaults; never the audio.
public struct DictationHistory: Equatable, Codable, Sendable {
    public static let limit = 10
    public private(set) var entries: [String] = []

    public init(entries: [String] = []) {
        self.entries = Array(entries.prefix(Self.limit))
    }

    public mutating func add(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        entries.insert(text, at: 0)
        if entries.count > Self.limit { entries.removeLast(entries.count - Self.limit) }
    }

    /// A menu label: one line, at most `length` characters.
    public static func label(for text: String, length: Int = 48) -> String {
        let oneLine = text.split(whereSeparator: \.isNewline).joined(separator: " ")
        return oneLine.count > length ? String(oneLine.prefix(length - 1)) + "…" : oneLine
    }
}
