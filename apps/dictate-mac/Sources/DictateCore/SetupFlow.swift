import Foundation

/// The setup window as steps (docs/PLAN-mac-onboarding.md R10-R12): Workspace, Sign in, Dictate,
/// Permissions, Done. The window opens at the first step that isn't finished; Workspace and Sign in
/// can't be skipped, Dictate and Permissions can (the permissions are asked again next launch while
/// any is missing, as before: docs/PLAN-mac-permissions.md).
public enum SetupFlow {
    public enum Step: Int, CaseIterable, Sendable {
        case workspace, signIn, dictate, permissions, done

        public var title: String {
            switch self {
            case .workspace: return "Workspace"
            case .signIn: return "Sign in"
            case .dictate: return "Dictate"
            case .permissions: return "Permissions"
            case .done: return "Done"
            }
        }

        /// Workspace and Sign in are needed for anything to work; the rest can wait.
        public var canSkip: Bool { self == .dictate || self == .permissions }

        /// "Step 2 of 4"; Done isn't counted.
        public var number: Int? { self == .done ? nil : rawValue + 1 }
        public static let counted = 4
    }

    public struct State: Equatable, Sendable {
        public var hasWorkspace: Bool
        public var signedIn: Bool
        public var dictateConnected: Bool
        public var missingPermissions: [PermissionCheck.Item]
        /// Steps the member skipped in this window; forgotten at the next launch.
        public var skipped: Set<Step>

        public init(hasWorkspace: Bool, signedIn: Bool, dictateConnected: Bool,
                    missingPermissions: [PermissionCheck.Item], skipped: Set<Step> = []) {
            self.hasWorkspace = hasWorkspace
            self.signedIn = signedIn
            self.dictateConnected = dictateConnected
            self.missingPermissions = missingPermissions
            self.skipped = skipped
        }
    }

    public static func isFinished(_ step: Step, _ state: State) -> Bool {
        switch step {
        case .workspace: return state.hasWorkspace
        case .signIn: return state.signedIn
        case .dictate: return state.dictateConnected
        case .permissions: return state.missingPermissions.isEmpty
        case .done: return true
        }
    }

    /// Where the window opens: the first step not finished and not skipped (Done when all are).
    public static func firstUnfinished(_ state: State) -> Step {
        Step.allCases.first { !isFinished($0, state) && !state.skipped.contains($0) } ?? .done
    }

    /// Whether Continue may leave `step`: finished, or one that can be skipped.
    public static func canLeave(_ step: Step, _ state: State) -> Bool {
        isFinished(step, state) || step.canSkip
    }

    /// The step after `step` that still needs the member, or Done.
    public static func next(after step: Step, _ state: State) -> Step {
        Step.allCases.first { $0.rawValue > step.rawValue && (!isFinished($0, state) || $0 == .done) } ?? .done
    }

    /// Whether launch opens the window (R11, R12): a Mac set up before opens straight to its window
    /// unless a permission went missing; any other unfinished step (no workspace, not signed in, or
    /// a first run) opens it at that step.
    public static func showAtLaunch(_ state: State, hasOnboarded: Bool) -> Bool {
        if !state.hasWorkspace || !state.signedIn || !state.missingPermissions.isEmpty { return true }
        return !hasOnboarded && !state.dictateConnected
    }

    /// Whether this Mac counts as signed in. The app can't see the window's session, so it counts
    /// a sign-in the app finished (or, once, a Mac set up before these steps: `migratedSignIn`) and
    /// a Dictate connection (made by signing in, or on the Dictate page while signed in).
    public static func signedIn(appSignIn: Bool, dictateConnected: Bool) -> Bool {
        appSignIn || dictateConnected
    }

    /// The first launch with these steps: a Mac that had closed setup and has a workspace was set
    /// up before, so it counts as signed in from then on (R12). Nil when there's nothing to change.
    public static func migratedSignIn(alreadyMigrated: Bool, hasOnboarded: Bool, hasWorkspace: Bool) -> Bool? {
        guard !alreadyMigrated else { return nil }
        return hasOnboarded && hasWorkspace
    }
}
