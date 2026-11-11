import Foundation

/// The numbers on the Dictations page.
public struct DictationStats: Equatable, Sendable {
    public struct AppUsage: Equatable, Sendable {
        public let name: String
        public let bundle: String?
        public let words: Int
    }

    public var dictations = 0
    public var totalWords = 0
    public var speakingMinutes = 0.0
    /// Typing the same words at 40 wpm, less the time spent speaking them; never negative.
    public var timeSavedMinutes = 0.0
    /// Words per minute of speech; 0 with no speech.
    public var averageWPM = 0
    public var topApps: [AppUsage] = []

    public static let typingWPM = 40.0

    public init() {}

    /// Stats over records on or after `since` (all of them when nil).
    public static func compute(_ records: [DictationRecord], since: Date?) -> DictationStats {
        let included = records.filter { since == nil || $0.date >= since! }
        var stats = DictationStats()
        stats.dictations = included.count
        stats.totalWords = included.reduce(0) { $0 + $1.words }
        stats.speakingMinutes = Double(included.reduce(0) { $0 + $1.audioMs }) / 60_000
        stats.timeSavedMinutes = max(0, Double(stats.totalWords) / typingWPM - stats.speakingMinutes)
        stats.averageWPM = stats.speakingMinutes > 0 ? Int((Double(stats.totalWords) / stats.speakingMinutes).rounded()) : 0
        var byApp: [String: (name: String, bundle: String?, words: Int)] = [:]
        for record in included {
            let key = record.appBundle ?? record.appName ?? "unknown"
            let name = record.appName ?? record.appBundle ?? "Unknown app"
            byApp[key, default: (name, record.appBundle, 0)].words += record.words
        }
        stats.topApps = byApp.values
            .sorted { $0.words != $1.words ? $0.words > $1.words : $0.name < $1.name }
            .map { AppUsage(name: $0.name, bundle: $0.bundle, words: $0.words) }
        return stats
    }
}

/// Words per day for one calendar month, for the activity grid.
public struct MonthActivity: Equatable, Sendable {
    public struct Day: Equatable, Sendable {
        public let date: Date
        public let words: Int
    }

    public let days: [Day]
    public var activeDays: Int { days.filter { $0.words > 0 }.count }
    /// Weekday of the 1st (1 = Sunday … 7 = Saturday, per the calendar), for laying out the grid.
    public let firstWeekday: Int

    public static func month(containing date: Date, records: [DictationRecord], calendar: Calendar = .current) -> MonthActivity {
        guard let interval = calendar.dateInterval(of: .month, for: date),
              let range = calendar.range(of: .day, in: .month, for: date)
        else { return MonthActivity(days: [], firstWeekday: 1) }
        var words: [Int: Int] = [:]
        for record in records where interval.contains(record.date) {
            words[calendar.component(.day, from: record.date), default: 0] += record.words
        }
        let days = range.compactMap { day -> Day? in
            guard let d = calendar.date(byAdding: .day, value: day - 1, to: interval.start) else { return nil }
            return Day(date: d, words: words[day] ?? 0)
        }
        return MonthActivity(days: days, firstWeekday: calendar.component(.weekday, from: interval.start))
    }

    /// 0…4, for the grid's shading: none, then quartiles of the month's busiest day.
    public func level(for day: Day) -> Int {
        guard day.words > 0, let most = days.map(\.words).max(), most > 0 else { return 0 }
        return min(4, 1 + Int(Double(day.words) / Double(most) * 3.999))
    }
}
