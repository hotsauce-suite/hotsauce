import Foundation

/// A calendar event as `GET /api/calendar/upcoming` returns it (the fields reminders need).
public struct UpcomingMeeting: Decodable, Equatable, Sendable {
    public struct Attendee: Decodable, Equatable, Sendable {
        public let email: String
    }

    public let id: String
    public let title: String
    public let start: Date
    public let end: Date?
    public let attendees: [Attendee]
    /// The event's video call link (Meet, Zoom, Teams...), when it has one.
    public let meetLink: String?

    public init(id: String, title: String, start: Date, end: Date? = nil, attendees: [Attendee], meetLink: String? = nil) {
        self.id = id
        self.title = title
        self.start = start
        self.end = end
        self.attendees = attendees
        self.meetLink = meetLink
    }

    /// The call to join from the reminder: only a web link, never another kind of URL a calendar
    /// invite could carry (a file, an app scheme).
    public var joinURL: URL? {
        guard let text = meetLink?.trimmingCharacters(in: .whitespacesAndNewlines),
              let url = URL(string: text), let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http", url.host?.isEmpty == false
        else { return nil }
        return url
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

    /// Start for this event, filled in and waiting for the member to press Start.
    public var pagePath: String {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&=+#?/")
        return "/meetings/start?event=" + (id.addingPercentEncoding(withAllowedCharacters: allowed) ?? id)
    }

    /// The page a reminder opens: Start for this event, which starts taking notes at once because
    /// the member chose to from the reminder.
    public var startPath: String { pagePath + "&via=mac-reminder" }

    /// The page the call notice opens when the call is this meeting: Start for the event, which
    /// starts at once and ends with the call.
    public func callStartPath(app: String) -> String {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&=+#?/")
        return pagePath + "&via=mac-call&app=" + (app.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")
    }

    /// Whether the event has a call link of any kind, as the server's web push counts it.
    public var hasCallLink: Bool {
        meetLink?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    }
}

/// The rule of the server's web push reminders (meetings/reminders/reminders.ts): a meeting with
/// attendees or a call link (a focus block has neither), starting within the next 90 seconds, reminded once per event and start time (a
/// moved meeting is reminded again at its new time).
public struct ReminderPlanner {
    public static let lead: TimeInterval = 90
    /// How far ahead to ask the server: a little more than the lead, so a pass that runs late
    /// still sees the meeting.
    public static let lookahead: TimeInterval = 5 * 60

    /// Reminded meetings by key, with their start, so old ones can be forgotten.
    public private(set) var sent: [String: Date] = [:]
    /// The reminded meetings themselves, so a call that starts can be matched to one.
    private var reminded: [String: UpcomingMeeting] = [:]

    /// A call this long before a reminded meeting's start counts as that meeting (people join early).
    public static let joinEarly: TimeInterval = 5 * 60
    /// A meeting with no end on the invite counts as this long.
    public static let assumedLength: TimeInterval = 30 * 60

    public init() {}

    public static func key(_ meeting: UpcomingMeeting) -> String {
        "\(meeting.id) \(Int(meeting.start.timeIntervalSince1970))"
    }

    /// The meetings to remind now; each is remembered so it isn't reminded twice.
    public mutating func due(_ meetings: [UpcomingMeeting], now: Date) -> [UpcomingMeeting] {
        let due = meetings.filter { meeting in
            (!meeting.attendees.isEmpty || meeting.hasCallLink)
                && meeting.start > now
                && meeting.start <= now.addingTimeInterval(Self.lead)
                && sent[Self.key(meeting)] == nil
        }
        for meeting in due {
            sent[Self.key(meeting)] = meeting.start
            reminded[Self.key(meeting)] = meeting
        }
        // Meetings that started over an hour ago can't be due again; forget them.
        sent = sent.filter { $0.value > now.addingTimeInterval(-3_600) }
        reminded = reminded.filter { sent[$0.key] != nil }
        return due
    }

    /// The reminded meeting a call starting `now` belongs to: from a few minutes before its start
    /// to its end. Of two, the one starting nearest `now`.
    public func remindedMeeting(at now: Date) -> UpcomingMeeting? {
        reminded.values
            .filter { meeting in
                let end = meeting.end ?? meeting.start.addingTimeInterval(Self.assumedLength)
                return now >= meeting.start.addingTimeInterval(-Self.joinEarly) && now <= end
            }
            .min { abs($0.start.timeIntervalSince(now)) < abs($1.start.timeIntervalSince(now)) }
    }
}
