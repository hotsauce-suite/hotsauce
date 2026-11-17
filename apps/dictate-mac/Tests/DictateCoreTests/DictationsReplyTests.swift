import Foundation
import Testing
@testable import DictateCore

// docs/PLAN-dictations-page.md R1, R2, R4, R6, R8.
@Suite struct DictationsReplyTests {
    let id = UUID(uuidString: "6F1C2E9A-1B2C-4D5E-8F90-123456789ABC")!

    @Test func readsTheDictationRequests() {
        #expect(MacSettingsBridge.parse(["type": "helloDictations"]) == .helloDictations)
        for range in DictationRange.allCases {
            #expect(MacSettingsBridge.parse(["type": "dictations", "range": range.rawValue, "search": "deck"]) == .dictations(range, search: "deck"))
        }
        #expect(MacSettingsBridge.parse(["type": "dictation", "id": id.uuidString, "action": "copy"]) == .dictation(id, .copy))
        #expect(MacSettingsBridge.parse(["type": "dictation", "id": id.uuidString, "action": "paste"]) == .dictation(id, .paste))
    }

    @Test func refusesMalformedDictationRequests() {
        let bad: [Any] = [
            ["type": "helloDictations", "extra": true],
            ["type": "dictations", "range": "year", "search": ""],
            ["type": "dictations", "range": "week"],
            ["type": "dictations", "range": "week", "search": NSNumber(value: 1)],
            ["type": "dictations", "range": "week", "search": String(repeating: "a", count: MacSettingsBridge.searchLimit + 1)],
            ["type": "dictations", "range": "week", "search": "", "limit": 5],
            ["type": "dictation", "id": "not-a-uuid", "action": "copy"],
            ["type": "dictation", "id": id.uuidString, "action": "delete"],
            ["type": "dictation", "id": id.uuidString],
        ]
        for body in bad { #expect(MacSettingsBridge.parse(body) == nil) }
        #expect(MacSettingsBridge.parse(["type": "dictations", "range": "all", "search": String(repeating: "a", count: MacSettingsBridge.searchLimit)]) != nil)
    }

    private func record(_ text: String, daysAgo: Double, app: String? = "Slack", bundle: String? = "com.tinyspeck.slackmacgap", now: Date, ms: Int = 6_000, onDevice: Bool? = nil, cleaned: Bool = true) -> DictationRecord {
        DictationRecord(date: now.addingTimeInterval(-daysAgo * 86_400), text: text, cleaned: cleaned, appName: app, appBundle: bundle, audioMs: ms, onDevice: onDevice)
    }

    @Test func countsTheRangeWithTheMacsOwnStats() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let now = try #require(ISO8601DateFormatter().date(from: "2026-11-17T12:00:00Z"))
        let records = [
            record("one two three", daysAgo: 1, now: now),
            record("four five", daysAgo: 2, app: "Mail", bundle: "com.apple.mail", now: now),
            record("six seven eight nine", daysAgo: 20, app: "Notes", bundle: "com.apple.Notes", now: now),
        ]
        let reply = DictationsReply.build(records: records, range: .week, search: "", now: now, calendar: calendar) { "data:image/png;base64,\($0)" }
        let stats = try #require(reply["stats"] as? [String: Any])
        let expected = DictationStats.compute(records, since: DictationRange.week.since(now))
        #expect(stats["dictations"] as? Int == 2)
        #expect(stats["totalWords"] as? Int == expected.totalWords)
        #expect(stats["averageWPM"] as? Int == expected.averageWPM)
        #expect(stats["timeSavedMinutes"] as? Double == expected.timeSavedMinutes)
        let top = try #require(stats["topApps"] as? [[String: Any]])
        #expect(top.map { $0["name"] as? String } == ["Slack", "Mail"])

        let month = try #require(reply["month"] as? [String: Any])
        let days = try #require(month["days"] as? [[String: Any]])
        #expect(days.count == 30)
        #expect(month["activeDays"] as? Int == 2) // the 20-days-ago one is October
        #expect(month["leadingBlanks"] as? Int == MonthActivity.month(containing: now, records: records, calendar: calendar).leadingBlanks)
        #expect(days[15]["words"] as? Int == 3) // Nov 16
        #expect(days[15]["level"] as? Int == 4)

        #expect(reply["total"] as? Int == 3)
        #expect(reply["matched"] as? Int == 3)
        let icons = try #require(reply["icons"] as? [String: Any])
        #expect(Set(icons.keys) == ["com.tinyspeck.slackmacgap", "com.apple.mail", "com.apple.Notes"])
    }

    @Test func listsTheNewestMatchesWithTheirTags() throws {
        let now = Date()
        let records = [
            record("Old note about the deck", daysAgo: 5, app: "Notes", bundle: nil, now: now, onDevice: true),
            record("Ship the deck today", daysAgo: 1, now: now, cleaned: false),
            record("Lunch?", daysAgo: 0.5, now: now),
        ]
        let reply = DictationsReply.build(records: records, range: .all, search: "  DECK ", now: now)
        let list = try #require(reply["records"] as? [[String: Any]])
        #expect(list.map { $0["text"] as? String } == ["Ship the deck today", "Old note about the deck"])
        #expect(list[0]["cleaned"] as? Bool == false)
        #expect(list[1]["onDevice"] as? Bool == true)
        #expect(list[1]["bundle"] is NSNull)
        #expect(list[0]["id"] as? String == records[1].id.uuidString)
        #expect(list[0]["date"] as? Double == (records[1].date.timeIntervalSince1970 * 1000).rounded())
        #expect(reply["matched"] as? Int == 2)
        // By app name too.
        #expect((DictationsReply.build(records: records, range: .all, search: "notes", now: now)["matched"] as? Int) == 1)
    }

    @Test func sendsAtMostTheNewest200() throws {
        let now = Date()
        let records = (0..<250).map { record("note \($0)", daysAgo: Double($0) / 100, now: now) }
        let reply = DictationsReply.build(records: records, range: .all, search: "", now: now)
        let list = try #require(reply["records"] as? [[String: Any]])
        #expect(list.count == DictationsReply.recentLimit)
        #expect(list.first?["text"] as? String == "note 0")
        #expect(reply["matched"] as? Int == 250)
    }
}
