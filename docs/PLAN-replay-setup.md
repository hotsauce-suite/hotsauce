# Run setup again (Mac app)

Status (2026-11-15): built. Morgan asked for "an option to trigger onboarding from Settings". The only
step-by-step onboarding is the Mac app's setup window (docs/PLAN-mac-onboarding.md R10-R12); the web
app has no member tour, and its `/setup` wizard only runs before an organization exists.

## Requirements

R1. The Mac app's Settings has a **Run setup again** button, and the app menu and the menu bar icon's
menu have **Run Setup Again…**. Each opens the setup window at step 1 (Workspace), even when the
window is already open on another step. [SetupFlowTests.aReplayVisitsEveryStepInOrder; real-Mac check]

R2. On a replay, Continue visits every step in order (Workspace, Sign in, Dictate, Permissions,
Done), including finished ones, which show their checkmarks. Opening the window any other way
(launch, Check Permissions…, a setup link) keeps today's behavior of skipping finished steps.
[SetupFlowTests.aReplayVisitsEveryStepInOrder, withoutAReplayContinueStillSkipsFinishedSteps]

R3. Replaying changes nothing: no sign-out, the workspace address stays, Dictate stays connected,
settings are untouched. A Mac with no workspace yet gets the empty Workspace field, as on a first
run. [code review: `beginReplay` only resets the window's own state]

## Support materials

Help page `site/public/help/mac-app.html`, `apps/dictate-mac/README.md`, the Done step's text.
