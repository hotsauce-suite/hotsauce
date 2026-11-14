# Mac app first run

Learnings from removing the built-in server address (`docs/PLAN-mac-onboarding.md`, slice 1).

- **A placeholder default is worse than none.** `ConnectLink.defaultServer` was
  `office.example.com`, so every fresh install with no Settings value and no Dictate connection
  loaded a host that doesn't exist, and the only button was Try again. Making the window's server
  optional (`SuiteWindow.router` is nil until there's a workspace) forces every caller to decide
  what "no workspace" means instead of quietly using a bad address.
- **Existing Macs already have an address.** A Mac that ever reached a real server has a Settings
  value or a Dictate connection (connecting and `serverMoved` both save `settings.suiteServer`),
  so dropping the default changes nothing for them. The one gap was disconnecting a Mac whose only
  address was its connection: `disconnect()` now saves it to Settings first.
- **"Unfamiliar server" needs a reference point.** It used to mean "not the default"; now it means
  "not this Mac's workspace", and with no workspace every server is unfamiliar, so connecting
  always asks.
- **Ask the server, not the user, who it is.** `/api/health` already carries `productName`,
  `authMode`, `orgName`, `signInDomain` and `publicUrl`; requiring `ok` + `productName` +
  `authMode` is enough to tell a Hotsauce server from a company website at the same address.
- **The window's own pages need their own link.** The Can't reach page is `loadHTMLString` with no
  base URL (`about:blank`), so its "Change workspace address" is a reserved URL
  (`SuitePages.changeWorkspaceURL`) that `decidePolicyFor` cancels and acts on only while one of
  those pages is showing; a server's page can't trigger it.
- **Two default buttons fight over Return.** The setup window's Done kept
  `.keyboardShortcut(.defaultAction)` while the Workspace step's Continue also had it; Done now
  drops it while the Workspace step shows.
- **Swift tests here need the Testing plugin path** with only the Command Line Tools:
  `swift test -Xswiftc -plugin-path -Xswiftc /Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing`.
- **R13 is a vitest test, not a shell grep** (`apps/web/src/apps/macNoOrgAddress.test.ts`): it runs
  in CI's unit job with no new workflow step, and lists every non-placeholder host it finds.

## Setup link (slice 2)

- **`hearth://setup` already meant something.** Any `hearth://<path>` is a deep link to that path
  on the workspace, so `hearth://setup` would have opened the server's own `/setup` wizard. The
  setup link is matched first, and only with a `server` parameter; without one it stays a deep link.
- **A link only fills the field.** Any web page can open a `hearth://` link, so the setup link never
  saves an address by itself: Continue runs the same `/api/health` check as a typed address.
- **Encode the origin on the web side** (`encodeURIComponent`); the Swift parser accepts both the
  encoded and the bare form, and a test covers the exact string the page builds.
- **Any page can fire a `hearth://` link without a click** (`SuiteRouter.decide` hands the scheme
  to the app before it looks at the frame or the click). So a link-filled address says it came from
  a link, and only a click on Continue checks it; Return doesn't.
- **A link can launch the app.** The URL event arrives before `applicationDidFinishLaunching`, so
  the launch's own "no workspace → Workspace step" must not reopen the step and blank the field.

## Sign-in connects Dictate (slice 3)

- **No new server route was needed.** `POST /api/dictation/devices` already takes a signed-in
  session, and right after `setActive` the finish page has one; the only new piece is the bridge.
- **Keep the finish page mounted until the handoff is done.** It used to `<Navigate>` as soon as auth
  turned signed-in; the app only answers on `/desktop/finish`, so the redirect now waits for the
  Dictate step (and still happens when the page opens already signed in).
- **Open the bridge from the ticket, not the URL.** The app opens the handoff when the finish page
  takes a fresh ticket, for 120 s and one connect; a page that merely loads `/desktop/finish` gets
  no answer.
- **`frameInfo.request.url` is the document's first URL**; pushState doesn't change it. Checking
  only that let a page that had *routed away* from /desktop/finish keep the bridge; the check now
  also needs the window's live URL, and a new document closes the handoff.
- **A silent connect may only fill a gap, never replace.** Replacing a connection to another server
  without asking would move someone's dictations; that path stays with the Dictate page's prompt.

## Setup as steps (slice 4)

- **The app can't see the window's session**, so "signed in" is what the app itself witnessed: a
  sign-in ticket the finish page took, or a Dictate connection. Macs set up before the steps get
  `appSignedIn` once, by a migration on their first launch with this version; using `hasOnboarded`
  directly would have counted a new Mac that closed setup at the Sign in step as signed in.
- **Opening the window and bringing it forward are different.** Opening a closed window resets it
  to the first unfinished step; a step finishing elsewhere (System Settings, the browser) only
  brings the open window forward, or it would jump the member back mid-flow.
- **Skips are per window, not saved.** Skipping Permissions doesn't stop the launch check: the
  window still opens next launch while one is missing (PLAN-mac-permissions P2).
