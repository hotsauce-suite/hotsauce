import Testing
@testable import DictateCore

/// The setup window's steps (docs/PLAN-mac-onboarding.md R10-R12).
@Suite struct SetupFlowTests {
    typealias Step = SetupFlow.Step
    func state(workspace: Bool = true, signedIn: Bool = true, dictate: Bool = true,
               missing: [PermissionCheck.Item] = [], skipped: Set<Step> = []) -> SetupFlow.State {
        SetupFlow.State(hasWorkspace: workspace, signedIn: signedIn, dictateConnected: dictate,
                        missingPermissions: missing, skipped: skipped)
    }

    @Test func opensAtTheFirstUnfinishedStep() {
        #expect(SetupFlow.firstUnfinished(state(workspace: false, signedIn: false, dictate: false, missing: [.microphone])) == .workspace)
        #expect(SetupFlow.firstUnfinished(state(signedIn: false, dictate: false)) == .signIn)
        #expect(SetupFlow.firstUnfinished(state(dictate: false, missing: [.accessibility])) == .dictate)
        #expect(SetupFlow.firstUnfinished(state(missing: [.accessibility])) == .permissions)
        #expect(SetupFlow.firstUnfinished(state()) == .done)
    }

    @Test func workspaceAndSignInCantBeSkipped() {
        #expect(!Step.workspace.canSkip)
        #expect(!Step.signIn.canSkip)
        #expect(Step.dictate.canSkip)
        #expect(Step.permissions.canSkip)
        #expect(!SetupFlow.canLeave(.workspace, state(workspace: false)))
        #expect(!SetupFlow.canLeave(.signIn, state(signedIn: false)))
        #expect(SetupFlow.canLeave(.dictate, state(dictate: false)))
        #expect(SetupFlow.canLeave(.permissions, state(missing: [.location])))
        // A skipped step isn't where the window opens again in this run, but a required one still is.
        #expect(SetupFlow.firstUnfinished(state(dictate: false, missing: [.location], skipped: [.dictate])) == .permissions)
    }

    @Test func nextSkipsWhatsAlreadyDone() {
        // Signing in connected Dictate too: Sign in goes straight on to Permissions.
        #expect(SetupFlow.next(after: .signIn, state(missing: [.microphone])) == .permissions)
        #expect(SetupFlow.next(after: .signIn, state(dictate: false)) == .dictate)
        #expect(SetupFlow.next(after: .permissions, state(missing: [.microphone])) == .done)
        #expect(SetupFlow.next(after: .workspace, state()) == .done)
    }

    @Test func stepsAreNumberedOneToFour() {
        #expect(Step.workspace.number == 1)
        #expect(Step.permissions.number == 4)
        #expect(Step.done.number == nil)
    }

    // R12: a Mac set up before opens straight to its window.
    @Test func aSetUpMacOpensStraightToItsWindow() {
        #expect(!SetupFlow.showAtLaunch(state(), hasOnboarded: true))
        // Dictate never connected on a Mac set up before: not a reason to open setup every launch.
        #expect(!SetupFlow.showAtLaunch(state(dictate: false), hasOnboarded: true))
    }

    // R11 and docs/PLAN-mac-permissions.md P2: anything required or a missing permission opens it.
    @Test func anUnfinishedMacOpensSetupAtLaunch() {
        #expect(SetupFlow.showAtLaunch(state(workspace: false, signedIn: false), hasOnboarded: false))
        #expect(SetupFlow.showAtLaunch(state(signedIn: false), hasOnboarded: true))
        #expect(SetupFlow.showAtLaunch(state(missing: [.accessibility]), hasOnboarded: true))
        #expect(SetupFlow.showAtLaunch(state(dictate: false), hasOnboarded: false))
        #expect(!SetupFlow.showAtLaunch(state(), hasOnboarded: false))
    }

    @Test func signedInCountsWhatTheAppCanSee() {
        #expect(SetupFlow.signedIn(appSignIn: true, dictateConnected: false))
        #expect(SetupFlow.signedIn(appSignIn: false, dictateConnected: true))
        #expect(!SetupFlow.signedIn(appSignIn: false, dictateConnected: false))
    }

    // R12, once: a Mac set up before these steps counts as signed in; a new Mac that closes setup
    // at Sign in later doesn't (the migration ran on its first launch, before it had closed setup).
    @Test func macsSetUpBeforeCountAsSignedInOnce() {
        #expect(SetupFlow.migratedSignIn(alreadyMigrated: false, hasOnboarded: true, hasWorkspace: true) == true)
        #expect(SetupFlow.migratedSignIn(alreadyMigrated: false, hasOnboarded: false, hasWorkspace: true) == false)
        #expect(SetupFlow.migratedSignIn(alreadyMigrated: false, hasOnboarded: true, hasWorkspace: false) == false)
        #expect(SetupFlow.migratedSignIn(alreadyMigrated: true, hasOnboarded: true, hasWorkspace: true) == nil)
    }
}
