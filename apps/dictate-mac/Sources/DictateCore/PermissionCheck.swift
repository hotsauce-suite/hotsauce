import Foundation

/// What the app checks each time it starts (docs/PLAN-mac-permissions.md P1–P3). Any permission
/// still missing opens the setup window again at launch, on every launch, until it's granted.
public enum PermissionCheck {
    public enum Item: String, CaseIterable, Sendable {
        case microphone, accessibility, location, notifications
    }

    /// What macOS reports right now. `notificationsNeeded` is false when both meeting reminders
    /// and call-notes offers are off in Settings: then nothing ever shows a notification.
    public struct Snapshot: Equatable, Sendable {
        public var microphone: Bool
        public var accessibility: Bool
        public var location: Bool
        public var notifications: Bool
        public var notificationsNeeded: Bool

        public init(microphone: Bool, accessibility: Bool, location: Bool, notifications: Bool, notificationsNeeded: Bool) {
            self.microphone = microphone
            self.accessibility = accessibility
            self.location = location
            self.notifications = notifications
            self.notificationsNeeded = notificationsNeeded
        }
    }

    /// The permissions still missing, in the order the window lists them.
    public static func missing(_ snapshot: Snapshot) -> [Item] {
        var items: [Item] = []
        if !snapshot.microphone { items.append(.microphone) }
        if !snapshot.accessibility { items.append(.accessibility) }
        if !snapshot.location { items.append(.location) }
        if snapshot.notificationsNeeded, !snapshot.notifications { items.append(.notifications) }
        return items
    }

    /// The first launch always shows the window; later launches show it while anything is missing,
    /// including a permission the member turned down (it's needed, so the app keeps asking).
    public static func showAtLaunch(hasOnboarded: Bool, missing: [Item]) -> Bool {
        !hasOnboarded || !missing.isEmpty
    }
}
