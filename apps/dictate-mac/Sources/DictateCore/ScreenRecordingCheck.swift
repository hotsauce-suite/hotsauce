import Foundation

/// Screen Recording for screenshots (docs/PLAN-screenshots.md R8). macOS's own check
/// (`CGPreflightScreenCaptureAccess`) is read once per process and can be wrong, so the app tries
/// the capture first and only explains when it really fails for permission. Which explanation to
/// give, and which failures are about permission, are decided here, tested.
public enum ScreenRecordingCheck {
    public enum Advice: Equatable, Sendable {
        /// Never asked before: turn Hotsauce on, then quit and reopen.
        case turnOn
        /// Asked during this run: the switch only counts once Hotsauce restarts.
        case restart
        /// Asked before, restarted since, and it still fails: a permission left from an older
        /// copy of the app. Remove Hotsauce from the list with − and turn it on again.
        case removeAndAddAgain
    }

    /// What to say after a capture failed for permission.
    public static func advice(askedBefore: Bool, launchedSinceAsking: Bool) -> Advice {
        guard askedBefore else { return .turnOn }
        return launchedSinceAsking ? .removeAndAddAgain : .restart
    }

    /// ScreenCaptureKit's error for "the user declined" (SCStreamError.userDeclined).
    static let streamErrorDomain = "com.apple.ScreenCaptureKit.SCStreamErrorDomain"
    static let userDeclined = -3801

    /// Whether a failed grab is about permission: ScreenCaptureKit says the user declined, or it
    /// failed while macOS reports no permission. Any other failure with permission is just a failure.
    public static func isPermissionFailure(domain: String, code: Int, preflightAllowed: Bool) -> Bool {
        if domain == streamErrorDomain, code == userDeclined { return true }
        return !preflightAllowed
    }

    /// Remembers in UserDefaults which run of the app last showed the explanation.
    public struct Memory {
        public static let key = "screenRecording.askedInLaunch"
        let defaults: UserDefaults
        /// This run of the app; a new one each launch.
        let launch: String

        public init(defaults: UserDefaults, launch: String) {
            self.defaults = defaults
            self.launch = launch
        }

        /// The advice for a permission failure now, remembering that this run asked.
        public func adviceAfterFailure() -> Advice {
            let asked = defaults.string(forKey: Self.key)
            let advice = ScreenRecordingCheck.advice(askedBefore: asked != nil, launchedSinceAsking: asked != nil && asked != launch)
            // After "remove and add again" the next run starts the count afresh from here.
            defaults.set(launch, forKey: Self.key)
            return advice
        }

        /// A capture worked: nothing left to explain next time.
        public func forget() {
            defaults.removeObject(forKey: Self.key)
        }
    }
}
