import DictateCore
import Foundation
import Testing

/// docs/PLAN-breaks.md B11 and B12: the app's side of screen breaks.
struct BreaksTests {
    private let page: [String: Any] = [
        "on": true, "everyMinutes": 20, "lengthSeconds": 20, "animation": "waves", "chime": false,
        "hours": ["start": "09:00", "end": "18:00", "days": [1, 2, 3, 4, 5]] as [String: Any],
    ]

    @Test func readsThePagesSettings() {
        let message = BreaksBridge.parse(["type": "settings", "settings": page])
        #expect(message == .settings(.init(
            on: true, everyMinutes: 20, lengthSeconds: 20, animation: .waves, chime: false,
            hours: .init(start: 540, end: 1080, days: [1, 2, 3, 4, 5])
        )))
        var noHours = page
        noHours["hours"] = NSNull()
        if case let .settings(s)? = BreaksBridge.parse(["type": "settings", "settings": noHours]) {
            #expect(s.hours == nil)
        } else {
            Issue.record("expected settings")
        }
    }

    @Test func readsBusyAndStartNow() {
        #expect(BreaksBridge.parse(["type": "busy", "busy": true]) == .busy(true))
        #expect(BreaksBridge.parse(["type": "startNow"]) == .startNow)
    }

    @Test func refusesAnythingElse() {
        var bad: [Any] = [
            "settings", ["type": "nope"], ["type": "busy", "busy": 1], ["type": "startNow", "x": 1],
            ["type": "busy"],
        ]
        for (key, value) in [("everyMinutes", 4 as Any), ("lengthSeconds", 901), ("animation", "fireworks"),
                             ("chime", "yes"), ("on", 1), ("everyMinutes", 20.5)] {
            var s = page
            s[key] = value
            bad.append(["type": "settings", "settings": s])
        }
        var sameTimes = page
        sameTimes["hours"] = ["start": "09:00", "end": "09:00", "days": [1]] as [String: Any]
        bad.append(["type": "settings", "settings": sameTimes])
        var badDay = page
        badDay["hours"] = ["start": "09:00", "end": "17:00", "days": [7]] as [String: Any]
        bad.append(["type": "settings", "settings": badDay])
        var noDays = page
        noDays["hours"] = ["start": "09:00", "end": "17:00", "days": [Int]()] as [String: Any]
        bad.append(["type": "settings", "settings": noDays])
        for body in bad { #expect(BreaksBridge.parse(body) == nil) }
    }

    @Test func keepsSettingsBetweenLaunches() {
        let s = BreaksBridge.Settings(on: true, everyMinutes: 45, lengthSeconds: 60, animation: .clouds,
                                      chime: true, hours: .init(start: 510, end: 1020, days: [1, 3]))
        #expect(BreaksBridge.decode(BreaksBridge.encode(s)) == s)
    }

    @Test func workingHours() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        func at(_ day: Int, _ hour: Int) -> Date {
            calendar.date(from: DateComponents(year: 2026, month: 11, day: day, hour: hour))!
        }
        let weekdays = BreaksBridge.WorkingHours(start: 540, end: 1080, days: [1, 2, 3, 4, 5])
        #expect(weekdays.contains(at(19, 9), calendar: calendar)) // Thursday
        #expect(!weekdays.contains(at(19, 18), calendar: calendar))
        #expect(!weekdays.contains(at(21, 12), calendar: calendar)) // Saturday
        let fridayNights = BreaksBridge.WorkingHours(start: 1320, end: 360, days: [5])
        #expect(fridayNights.contains(at(20, 23), calendar: calendar))
        #expect(fridayNights.contains(at(21, 5), calendar: calendar))
        #expect(!fridayNights.contains(at(21, 23), calendar: calendar))
    }

    @Test func scheduleWarnsBreaksAndEnds() {
        let s = BreaksBridge.Settings(on: true)
        let t0 = Date(timeIntervalSince1970: 0)
        var schedule = BreakSchedule.start(s, now: t0)
        var events: [(TimeInterval, BreakSchedule.Event)] = []
        for second in 0...(41 * 60) {
            let now = t0.addingTimeInterval(TimeInterval(second))
            let (next, event) = schedule.step(s, now: now, busy: false, idle: 0, inHours: true)
            schedule = next
            if let event { events.append((TimeInterval(second), event)) }
        }
        #expect(events.map(\.0) == [1190, 1200, 1220, 2410, 2420, 2440])
        #expect(events.map(\.1) == [.warn, .start, .end, .warn, .start, .end])
    }

    @Test func scheduleWaitsWhileBusyAndCountsTimeAway() {
        let s = BreaksBridge.Settings(on: true)
        let t0 = Date(timeIntervalSince1970: 0)
        var schedule = BreakSchedule.start(s, now: t0)
        var firstWarn: TimeInterval?
        for second in 0...(35 * 60) {
            let now = t0.addingTimeInterval(TimeInterval(second))
            let busy = second >= 15 * 60 && second < 30 * 60
            let (next, event) = schedule.step(s, now: now, busy: busy, idle: 0, inHours: true)
            schedule = next
            if event == .warn, firstWarn == nil { firstWarn = TimeInterval(second) }
        }
        #expect(firstWarn == TimeInterval(30 * 60 - 1 + 60 - 10))

        let (afterAway, event) = BreakSchedule.start(s, now: t0)
            .step(s, now: t0.addingTimeInterval(600), busy: false, idle: 20, inHours: true)
        #expect(event == .reset)
        #expect(afterAway.dueAt == t0.addingTimeInterval(600 + 1200))
    }
}
