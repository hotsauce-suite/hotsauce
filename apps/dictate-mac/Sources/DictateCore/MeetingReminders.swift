import Foundation

/// A calendar event as `GET /api/calendar/upcoming` returns it (the fields reminders need).
public struct UpcomingMeeting: Decodable, Equatable, Sendable {
    public struct Attendee: Decodable, Equatable, Sendable {
        public let email: String
    }

    public let id: String
    public let title: String
    public let start: Date
    public let attendees: [Attendee]

    public init(id: String, title: String, start: Date, attendees: [Attendee]) {
        self.id = id
        self.title = title
        self.start = start
        self.attendees = attendees
    }

    /// The server's JSON array; ISO timestamps with or without milliseconds.
    public static func decodeList(_ data: Data) throws -> [UpcomingMeeting] {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            let precise = ISO8601DateFormatter()
            precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = precise.date(from: text) ?? ISO8601DateFormatter().date(from: text) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Not an ISO timestamp: \(text)"))
        }
        return try decoder.decode([UpcomingMeeting].self, from: data)
    }

    /// The page a reminder opens: Start for this event, as the web push does.
    public var startPath: String {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&=+#?/")
        return "/meetings/start?event=" + (id.addingPercentEncoding(withAllowedCharacters: allowed) ?? id)
    }
}

/// The rule of the server's web push reminders (meetings/reminders/reminders.ts): a meeting with
/// attendees, starting within the next 90 seconds, reminded once per event and start time (a
/// moved meeting is reminded again at its new time).
public struct ReminderPlanner {
    public static let lead: TimeInterval = 90
    /// How far ahead to ask the server: a little more than the lead, so a pass that runs late
    /// still sees the meeting.
    public static let lookahead: TimeInterval = 5 * 60

    /// Reminded meetings by key, with their start, so old ones can be forgotten.
    public private(set) var sent: [String: Date] = [:]

    public init() {}

    public static func key(_ meeting: UpcomingMeeting) -> String {
        "\(meeting.id) \(Int(meeting.start.timeIntervalSince1970))"
    }

    /// The meetings to remind now; each is remembered so it isn't reminded twice.
    public mutating func due(_ meetings: [UpcomingMeeting], now: Date) -> [UpcomingMeeting] {
        let due = meetings.filter { meeting in
            !meeting.attendees.isEmpty
                && meeting.start > now
                && meeting.start <= now.addingTimeInterval(Self.lead)
                && sent[Self.key(meeting)] == nil
        }
        for meeting in due { sent[Self.key(meeting)] = meeting.start }
        // Meetings that started over an hour ago can't be due again; forget them.
        sent = sent.filter { $0.value > now.addingTimeInterval(-3_600) }
        return due
    }
}
