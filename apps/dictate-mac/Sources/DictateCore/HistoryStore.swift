import Foundation

/// One dictation as kept on this Mac. Never the audio; never uploaded.
public struct DictationRecord: Codable, Equatable, Identifiable, Sendable {
    public var id: UUID
    public var date: Date
    public var text: String
    /// Whether the cleanup pass ran (false: the raw transcript, literal mode, or a fallback).
    public var cleaned: Bool
    public var appName: String?
    public var appBundle: String?
    /// How long the member spoke.
    public var audioMs: Int
    public var words: Int
    /// Key-up to text, server ASR and LLM, network: milliseconds.
    public var timings: [String: Int]

    public init(id: UUID = UUID(), date: Date, text: String, cleaned: Bool, appName: String?, appBundle: String?, audioMs: Int, timings: [String: Int] = [:]) {
        self.id = id
        self.date = date
        self.text = text
        self.cleaned = cleaned
        self.appName = appName
        self.appBundle = appBundle
        self.audioMs = audioMs
        self.words = Self.wordCount(text)
        self.timings = timings
    }

    /// Words as a person would count them: runs of letters or digits. Chinese and Japanese text,
    /// which has no spaces, counts one word per character, which is close to how it is typed.
    public static func wordCount(_ text: String) -> Int {
        var count = 0
        var inWord = false
        for scalar in text.unicodeScalars {
            if isCJK(scalar) {
                count += 1
                inWord = false
            } else if CharacterSet.alphanumerics.contains(scalar) {
                if !inWord { count += 1 }
                inWord = true
            } else if scalar != "'" && scalar != "’" {
                inWord = false
            }
        }
        return count
    }

    private static func isCJK(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x3040...0x30FF, 0x3400...0x4DBF, 0x4E00...0x9FFF, 0xF900...0xFAFF: true
        default: false
        }
    }
}

/// The dictation history, newest first, in one JSON file only this user can read
/// (~/Library/Application Support/HearthDictate/history.json, 0600 in a 0700 folder).
public final class HistoryStore {
    public let url: URL
    public private(set) var records: [DictationRecord] = []

    public static var defaultURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("HearthDictate", isDirectory: true).appendingPathComponent("history.json")
    }

    /// Writes happen here, off the main thread, in order.
    private let queue = DispatchQueue(label: "dev.hotsauce.dictate.history")

    public init(url: URL = HistoryStore.defaultURL) {
        self.url = url
        guard let data = try? Data(contentsOf: url) else { return }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        if let decoded = try? decoder.decode([DictationRecord].self, from: data) {
            records = decoded
        } else {
            // Unreadable (a newer format, a damaged file): set it aside rather than overwrite it.
            let aside = url.deletingLastPathComponent().appendingPathComponent("history-unreadable-\(Int(Date().timeIntervalSince1970)).json")
            try? FileManager.default.moveItem(at: url, to: aside)
        }
    }

    /// Waits for writes already queued (tests, and before quitting).
    public func flush() {
        queue.sync {}
    }

    public func add(_ record: DictationRecord) {
        records.insert(record, at: 0)
        save()
    }

    /// Drops everything older than `days` days.
    @discardableResult
    public func prune(retentionDays days: Int, now: Date = Date()) -> Int {
        let cutoff = now.addingTimeInterval(-Double(days) * 86_400)
        let before = records.count
        records.removeAll { $0.date < cutoff }
        if records.count != before { save() }
        return before - records.count
    }

    public func clear() {
        records = []
        let url = url
        queue.async {
            let fm = FileManager.default
            let dir = url.deletingLastPathComponent()
            try? fm.removeItem(at: url)
            // And any temp file a failed write left.
            for name in (try? fm.contentsOfDirectory(atPath: dir.path)) ?? [] where name.hasPrefix(".history.json-") {
                try? fm.removeItem(at: dir.appendingPathComponent(name))
            }
        }
    }

    private func save() {
        let snapshot = records
        let url = url
        queue.async { Self.write(snapshot, to: url) }
    }

    private static func write(_ records: [DictationRecord], to url: URL) {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(records) else { return }
        PrivateFile.write(data, to: url)
    }
}
