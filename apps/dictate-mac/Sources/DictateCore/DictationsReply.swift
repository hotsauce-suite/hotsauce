import Foundation

/// What the Dictations page counts: the last 7 or 30 days, or everything kept.
public enum DictationRange: String, CaseIterable, Sendable {
    case week, month, all

    public func since(_ now: Date) -> Date? {
        switch self {
        case .week: now.addingTimeInterval(-7 * 86_400)
        case .month: now.addingTimeInterval(-30 * 86_400)
        case .all: nil
        }
    }
}

/// The Dictate page's "On this Mac" (docs/PLAN-dictations-page.md), as the page reads it
/// (apps/web/src/lib/macDictations.ts parseMacDictations). The numbers are the Mac's own (R4).
public enum DictationsReply {
    /// Recent dictations sent at most (R2).
    public static let recentLimit = 200
    /// Top sources sent at most (R1).
    public static let topAppsLimit = 6

    /// The newest first, matching `search` in the text or the app's name (R2).
    public static func recent(_ records: [DictationRecord], search: String) -> [DictationRecord] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        let newest = records.sorted { $0.date > $1.date }
        guard !query.isEmpty else { return newest }
        return newest.filter {
            $0.text.localizedCaseInsensitiveContains(query) || ($0.appName ?? "").localizedCaseInsensitiveContains(query)
        }
    }

    /// `icon` gives an app's icon as a data URL by bundle id, or nil (R8).
    public static func build(
        records: [DictationRecord],
        range: DictationRange,
        search: String,
        now: Date = Date(),
        calendar: Calendar = .current,
        icon: (String) -> String? = { _ in nil }
    ) -> [String: Any] {
        let stats = DictationStats.compute(records, since: range.since(now))
        let month = MonthActivity.month(containing: now, records: records, calendar: calendar)
        let matches = recent(records, search: search)
        let shown = Array(matches.prefix(recentLimit))
        let top = Array(stats.topApps.prefix(topAppsLimit))

        var bundles = Set<String>()
        top.compactMap(\.bundle).forEach { bundles.insert($0) }
        shown.compactMap(\.appBundle).forEach { bundles.insert($0) }
        var icons: [String: Any] = [:]
        for bundle in bundles.sorted() {
            if let url = icon(bundle) { icons[bundle] = url }
        }

        return [
            "range": range.rawValue,
            "stats": [
                "dictations": stats.dictations,
                "totalWords": stats.totalWords,
                "timeSavedMinutes": stats.timeSavedMinutes,
                "averageWPM": stats.averageWPM,
                "topApps": top.map { app -> [String: Any] in
                    ["name": app.name, "bundle": app.bundle.map { $0 as Any } ?? NSNull(), "words": app.words]
                },
            ] as [String: Any],
            "month": [
                "start": milliseconds(month.days.first?.date ?? now),
                "leadingBlanks": month.leadingBlanks,
                "days": month.days.map { ["words": $0.words, "level": month.level(for: $0)] },
                "activeDays": month.activeDays,
            ] as [String: Any],
            "total": records.count,
            "matched": matches.count,
            "records": shown.map { record -> [String: Any] in
                [
                    "id": record.id.uuidString,
                    "date": milliseconds(record.date),
                    "text": record.text,
                    "app": record.appName.map { $0 as Any } ?? NSNull(),
                    "bundle": record.appBundle.map { $0 as Any } ?? NSNull(),
                    "cleaned": record.cleaned,
                    "onDevice": record.onDevice == true,
                ]
            },
            "icons": icons,
        ]
    }

    private static func milliseconds(_ date: Date) -> Double {
        (date.timeIntervalSince1970 * 1000).rounded()
    }
}
