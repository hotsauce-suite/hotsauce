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
