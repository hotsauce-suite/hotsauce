import Foundation

/// Screen breaks in the app (docs/PLAN-breaks.md B11, B12). The suite's page hands the app the
/// member's settings and its recording state through the `hotsauceBreaks` handler; the app keeps
/// the timer (so breaks come with the window closed) and shows the break over every display. The
/// rules are the page's (apps/web/src/breaks/schedule.ts), kept the same here.
public enum BreaksBridge {
    public static let handlerName = "hotsauceBreaks"

    public enum Animation: String, CaseIterable, Sendable {
        case breathe, clouds, waves
    }

    public struct WorkingHours: Equatable, Sendable {
        /// Minutes after midnight, local time.
        public var start: Int
        public var end: Int
        /// 0 is Sunday, 6 Saturday.
        public var days: Set<Int>

        public init(start: Int, end: Int, days: Set<Int>) {
            self.start = start
            self.end = end
            self.days = days
        }

        /// Hours that cross midnight belong to the day they start (as the page's).
        public func contains(_ date: Date, calendar: Calendar = .current) -> Bool {
            let parts = calendar.dateComponents([.hour, .minute, .weekday], from: date)
            let now = (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
            let day = ((parts.weekday ?? 1) - 1) // Calendar's weekday: 1 is Sunday.
            if start < end { return days.contains(day) && now >= start && now < end }
            if now >= start { return days.contains(day) }
            if now < end { return days.contains((day + 6) % 7) }
            return false
        }
    }

    public struct Settings: Equatable, Sendable {
        public var on: Bool
        public var everyMinutes: Int
        public var lengthSeconds: Int
        public var animation: Animation
        public var chime: Bool
        public var hours: WorkingHours?

        public init(on: Bool = false, everyMinutes: Int = 20, lengthSeconds: Int = 20,
                    animation: Animation = .breathe, chime: Bool = true, hours: WorkingHours? = nil) {
            self.on = on
            self.everyMinutes = everyMinutes
            self.lengthSeconds = lengthSeconds
            self.animation = animation
            self.chime = chime
            self.hours = hours
        }

        public var every: TimeInterval { TimeInterval(everyMinutes * 60) }
        public var length: TimeInterval { TimeInterval(lengthSeconds) }
    }

    public enum Message: Equatable, Sendable {
        case settings(Settings)
        /// The page has a recording, dictation, screen share or calendar meeting on.
        case busy(Bool)
        /// "Take a break now" in Settings.
        case startNow
    }

    /// Reads what the page posted; nil for anything else (strict, since any script on the page
    /// can post to the handler).
    public static func parse(_ body: Any) -> Message? {
        guard let message = body as? [String: Any], let type = message["type"] as? String else { return nil }
        switch type {
        case "startNow": return message.count == 1 ? .startNow : nil
        case "busy":
            guard message.count == 2, let busy = bool(message["busy"]) else { return nil }
            return .busy(busy)
        case "settings":
            guard message.count == 2, let s = message["settings"] as? [String: Any] else { return nil }
            return settings(s).map(Message.settings)
        default: return nil
        }
    }

    static func settings(_ s: [String: Any]) -> Settings? {
        guard let on = bool(s["on"]),
              let every = int(s["everyMinutes"]), (5...120).contains(every),
              let length = int(s["lengthSeconds"]), (10...900).contains(length),
              let animation = (s["animation"] as? String).flatMap(Animation.init(rawValue:)),
              let chime = bool(s["chime"])
        else { return nil }
        var hours: WorkingHours?
        if let h = s["hours"], !(h is NSNull) {
            guard let h = h as? [String: Any],
                  let start = (h["start"] as? String).flatMap(minutes),
                  let end = (h["end"] as? String).flatMap(minutes), start != end,
                  let list = h["days"] as? [Any], list.count <= 7
            else { return nil }
            var days = Set<Int>()
            for d in list {
                guard let d = int(d), (0...6).contains(d) else { return nil }
                days.insert(d)
            }
            hours = WorkingHours(start: start, end: end, days: days)
        }
        return Settings(on: on, everyMinutes: every, lengthSeconds: length, animation: animation, chime: chime, hours: hours)
    }

    /// "09:30" → 570.
    static func minutes(_ text: String) -> Int? {
        let parts = text.split(separator: ":")
        guard text.count == 5, parts.count == 2, let h = Int(parts[0]), let m = Int(parts[1]),
              (0...23).contains(h), (0...59).contains(m) else { return nil }
        return h * 60 + m
    }

    private static func bool(_ v: Any?) -> Bool? {
        guard let n = v as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }
        return n.boolValue
    }

    private static func int(_ v: Any?) -> Int? {
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let d = n.doubleValue
        guard d == d.rounded(), abs(d) < 1_000_000 else { return nil }
        return Int(d)
    }

    // The settings as the app keeps them between launches (so breaks come before the page loads).

    public static func encode(_ s: Settings) -> [String: Any] {
        var dict: [String: Any] = [
            "on": s.on, "everyMinutes": s.everyMinutes, "lengthSeconds": s.lengthSeconds,
            "animation": s.animation.rawValue, "chime": s.chime,
        ]
        if let h = s.hours {
            dict["hours"] = [
                "start": String(format: "%02d:%02d", h.start / 60, h.start % 60),
                "end": String(format: "%02d:%02d", h.end / 60, h.end % 60),
                "days": h.days.sorted(),
            ] as [String: Any]
        }
        return dict
    }

    public static func decode(_ dict: [String: Any]) -> Settings? { settings(dict) }
}

/// When the next break comes: the page's `schedule.ts`, in Swift.
public struct BreakSchedule: Equatable, Sendable {
    public static let warn: TimeInterval = 10
    public static let grace: TimeInterval = 60
    public static let snooze: TimeInterval = 5 * 60

    public enum Phase: Equatable, Sendable {
        case counting
        case warning(startsAt: Date)
        case onBreak(endsAt: Date)
    }

    public enum Event: Equatable, Sendable { case warn, start, end, reset }

    public var dueAt: Date
    public var phase: Phase

    public init(dueAt: Date, phase: Phase = .counting) {
        self.dueAt = dueAt
        self.phase = phase
    }

    public static func start(_ s: BreaksBridge.Settings, now: Date) -> BreakSchedule {
        BreakSchedule(dueAt: now.addingTimeInterval(s.every))
    }

    public static func startNow(_ s: BreaksBridge.Settings, now: Date) -> BreakSchedule {
        BreakSchedule(dueAt: now, phase: .onBreak(endsAt: now.addingTimeInterval(s.length)))
    }

    public static func skip(_ s: BreaksBridge.Settings, now: Date) -> BreakSchedule { start(s, now: now) }

    public static func snoozed(now: Date) -> BreakSchedule { BreakSchedule(dueAt: now.addingTimeInterval(snooze)) }

    /// One step, about once a second.
    public func step(_ s: BreaksBridge.Settings, now: Date, busy: Bool, idle: TimeInterval, inHours: Bool) -> (BreakSchedule, Event?) {
        if case let .onBreak(endsAt) = phase {
            if now >= endsAt { return (.start(s, now: now), .end) }
            return (self, nil)
        }
        if idle >= s.length { return (.start(s, now: now), .reset) }
        let warning: Bool = { if case .warning = phase { return true } else { return false } }()
        if !inHours { return (.start(s, now: now), warning ? .reset : nil) }
        if busy {
            let due = max(dueAt, now.addingTimeInterval(Self.grace))
            return (BreakSchedule(dueAt: due), warning ? .reset : nil)
        }
        if case let .warning(startsAt) = phase {
            if now >= startsAt { return (BreakSchedule(dueAt: startsAt, phase: .onBreak(endsAt: now.addingTimeInterval(s.length))), .start) }
            return (self, nil)
        }
        if now >= dueAt.addingTimeInterval(-Self.warn) {
            let startsAt = now > dueAt ? now.addingTimeInterval(Self.warn) : dueAt
            return (BreakSchedule(dueAt: startsAt, phase: .warning(startsAt: startsAt)), .warn)
        }
        return (self, nil)
    }
}
