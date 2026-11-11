import Foundation
import Testing
@testable import DictateCore

@Suite struct HistoryStoreTests {
    private func tempURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("hearth-dictate-test-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent("history.json")
    }

    private func record(_ text: String, daysAgo: Double, now: Date, app: String = "Slack") -> DictationRecord {
        DictationRecord(date: now.addingTimeInterval(-daysAgo * 86_400), text: text, cleaned: true, appName: app, appBundle: "b.\(app)", audioMs: 3_000)
    }

    @Test func persistsNewestFirstInAPrivateFile() throws {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let now = Date()
        let store = HistoryStore(url: url)
        store.add(record("first one", daysAgo: 1, now: now))
        store.add(record("second one", daysAgo: 0, now: now))
        store.flush()
        let reopened = HistoryStore(url: url)
        #expect(reopened.records.map(\.text) == ["second one", "first one"])
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        #expect((attrs[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        let dirAttrs = try FileManager.default.attributesOfItem(atPath: url.deletingLastPathComponent().path)
        #expect((dirAttrs[.posixPermissions] as? NSNumber)?.intValue == 0o700)
        // No temp files left behind.
        let files = try FileManager.default.contentsOfDirectory(atPath: url.deletingLastPathComponent().path)
        #expect(files == ["history.json"])
    }

    @Test func prunesPastTheRetention() {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let now = Date()
        let store = HistoryStore(url: url)
        for days in [0.5, 6.9, 7.1, 40] { store.add(record("d\(days)", daysAgo: days, now: now)) }
        #expect(store.prune(retentionDays: 7, now: now) == 2)
        store.flush()
        #expect(Set(HistoryStore(url: url).records.map(\.text)) == ["d0.5", "d6.9"])
    }

    @Test func clearRemovesTheFile() {
        let url = tempURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let store = HistoryStore(url: url)
        store.add(record("x", daysAgo: 0, now: Date()))
        store.clear()
        store.flush()
        #expect(store.records.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: url.path))
    }

    @Test func setsAsideAFileItCantRead() throws {
        let url = tempURL()
        let dir = url.deletingLastPathComponent()
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data("{not json".utf8).write(to: url)
        let store = HistoryStore(url: url)
        #expect(store.records.isEmpty)
        let names = try FileManager.default.contentsOfDirectory(atPath: dir.path)
        #expect(names.contains { $0.hasPrefix("history-unreadable-") })
        #expect(!names.contains("history.json"))
    }

    @Test func countsWords() {
        #expect(DictationRecord.wordCount("Ship it on Wednesday, don’t wait.") == 6)
        #expect(DictationRecord.wordCount("- one\n- two") == 2)
        #expect(DictationRecord.wordCount("") == 0)
        #expect(DictationRecord.wordCount("我们发布") == 4)
    }
}

@Suite struct StatsTests {
    let now = Date(timeIntervalSince1970: 1_762_790_400) // 2025-11-10 16:00 UTC

    private func record(_ words: Int, audioSeconds: Int, daysAgo: Double, app: String?, bundle: String?) -> DictationRecord {
        DictationRecord(date: now.addingTimeInterval(-daysAgo * 86_400), text: Array(repeating: "word", count: words).joined(separator: " "), cleaned: true, appName: app, appBundle: bundle, audioMs: audioSeconds * 1000)
    }

    @Test func totalsTimeSavedAndWPM() {
        let records = [
            record(120, audioSeconds: 60, daysAgo: 1, app: "Slack", bundle: "s"),
            record(80, audioSeconds: 30, daysAgo: 2, app: "Mail", bundle: "m"),
            record(40, audioSeconds: 30, daysAgo: 3, app: "Slack", bundle: "s"),
        ]
        let stats = DictationStats.compute(records, since: nil)
        #expect(stats.dictations == 3)
        #expect(stats.totalWords == 240)
        #expect(stats.speakingMinutes == 2)
        #expect(stats.averageWPM == 120)
        // 240 words at 40 wpm is 6 minutes of typing, less 2 of speaking.
        #expect(stats.timeSavedMinutes == 4)
        #expect(stats.topApps == [.init(name: "Slack", bundle: "s", words: 160), .init(name: "Mail", bundle: "m", words: 80)])
    }

    @Test func respectsTheRange() {
        let records = [record(10, audioSeconds: 5, daysAgo: 1, app: "A", bundle: "a"), record(50, audioSeconds: 5, daysAgo: 10, app: "A", bundle: "a")]
        #expect(DictationStats.compute(records, since: now.addingTimeInterval(-7 * 86_400)).totalWords == 10)
        #expect(DictationStats.compute(records, since: nil).totalWords == 60)
    }

    @Test func timeSavedIsNeverNegativeAndWPMNeedsSpeech() {
        let slow = DictationStats.compute([record(5, audioSeconds: 60, daysAgo: 0, app: nil, bundle: nil)], since: nil)
        #expect(slow.timeSavedMinutes == 0)
        #expect(slow.topApps.first?.name == "Unknown app")
        let empty = DictationStats.compute([], since: nil)
        #expect(empty.averageWPM == 0)
        #expect(empty.timeSavedMinutes == 0)
    }

    @Test func monthActivityCountsWordsPerDay() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "UTC"))
        let records = [
            record(10, audioSeconds: 5, daysAgo: 0, app: "A", bundle: "a"),
            record(30, audioSeconds: 5, daysAgo: 0.1, app: "A", bundle: "a"),
            record(5, audioSeconds: 5, daysAgo: 2, app: "A", bundle: "a"),
            record(99, audioSeconds: 5, daysAgo: 40, app: "A", bundle: "a"),
        ]
        let month = MonthActivity.month(containing: now, records: records, calendar: calendar)
        #expect(month.days.count == 30) // November
        #expect(month.days[9].words == 40) // the 10th
        #expect(month.days[7].words == 5)
        #expect(month.activeDays == 2)
        #expect(month.firstWeekday == 7) // 1 November 2025 was a Saturday
        #expect(month.level(for: month.days[9]) == 4)
        #expect(month.level(for: month.days[7]) == 1)
        #expect(month.level(for: month.days[0]) == 0)
    }
}
