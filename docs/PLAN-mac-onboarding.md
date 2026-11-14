# Plan: step-by-step first run in the Mac app

Status (2026-11-14): slice 1 (R1-R3, R6, R13) shipped in 0.12.7 (#79); slice 2 (R4, R5) in 0.12.8 (#83).
Slice 3 (R7-R9) in progress on feat/mac-signin-connects-dictate. Morgan accepted the plan's answers: setup link
and typed address, Google sign-in also connects Dictate, Mic/Accessibility/Location/Notifications in setup,
workspace and sign-in required, permissions skippable, already-set-up Macs skip the flow. Slice 4 not started.
Asked for by the owner: "Start with sign in with Google, then do dictate connect then do all the
permissions you need."

## Why a co-founder saw "Can't reach Hotsauce"

The app picks its window's address as: the address in Settings, else the server Dictate is
connected to, else a built-in default (`ServerAddress.windowServer`). The built-in default is the
placeholder `https://office.example.com` (`ConnectLink.defaultServer`). A Mac with no Settings
value and no Dictate connection, which is every fresh install (and every Mac whose old Hearth-era
copy used another bundle id), opens that placeholder, and macOS answers "A server with the
specified hostname could not be found". The error page only offers Try again, so the member has no
way forward without knowing about Settings. Nothing ever asked for the address.

## The flow

Shown on first run, and whenever the app has no workspace address or isn't signed in. Macs that
are already set up never see it; they keep the current permissions check at launch.

1. **Workspace.** "Where does your team's Hotsauce live?" One field. Accepts `team.example.com`,
   with or without https. The app checks `/api/health` before going on and shows what it found
   ("Acme. Sign in with your acme.com Google account"), or a plain error. A setup link
   from the workspace's own download page (`hearth://setup?server=…`) fills the field, so most
   people only press Continue.
2. **Sign in with Google.** The existing browser sign-in (`/desktop/connect` → `hearth://auth/callback`
   → `/desktop/finish`). Google won't sign in inside an app's web view, so the browser does it.
3. **Dictate.** Connected by the same sign-in: the finish page, now signed in, creates a Dictate
   device for this Mac and hands the token to the app over the script bridge (never in a URL).
   The step shows "Dictate is connected as you@…" and a practice box: hold Right Option, speak,
   let go.
4. **Permissions.** Microphone, Accessibility, Location, Notifications, one row each with the live
   checks the setup window has today. Camera, screen and system audio are still asked for on first
   use.
5. **Done.** Opens Today in the app window.

## Requirements

R1. No built-in server address. With no Settings value and no connection, the app shows the
    Workspace step and loads nothing. [ServerAddressTests]
R2. The Workspace field accepts a bare host or a full URL, https only (http for localhost), and
    keeps only the origin. [ConnectLinkTests]
R3. Continue checks `<origin>/api/health`; it goes on only when the answer is a Hotsauce server,
    and shows its `orgName` and `signInDomain`. A server whose `publicUrl` differs moves the field
    to that address. [ServerAddressTests with recorded health JSON]
R4. `hearth://setup?server=<origin>` opens the setup window with the field filled; it never skips
    the check in R3. [SuiteRouterTests]
R5. The web download page and install help show the setup link for their own server. [web unit test]
R6. "Can't reach" page names the address it tried and has a "Change workspace address" button that
    opens the Workspace step. [SuiteWindow page test, manual check]
R7. Sign in with Google uses the existing browser sign-in, with the state nonce and ticket rules
    unchanged. [BrowserSignInTests]
R8. After `/desktop/finish` signs the window in, the page creates a Dictate device ("<Mac name>")
    through the signed-in API and passes the token to the app through a new bridge; the app saves it
    like a pasted code. No token appears in a URL. If the Mac already has a working connection to
    the same server, nothing is created. [server route test, web unit test, Swift test]
R9. The Dictate step shows the connected account and a practice box that runs one dictation into
    the box. A "Connect with a code instead" link keeps the old paste path. [manual check]
R10. The Permissions step reuses today's rows and checks (PLAN-mac-permissions P1-P6 keep holding).
     [PermissionCheckTests]
R11. Each step can be left with the window's close button; the app reopens the first unfinished
     step at the next launch. Workspace and Sign in can't be skipped inside the flow. [manual check]
R12. A Mac that is already signed in and connected opens straight to its window, as today.
     [PermissionCheckTests, manual check on Morgan's Mac]
R13. No organization's address or name is in the app's code; all of it comes from the server.
     [grep check in CI]

## Slices

1. Placeholder gone, Workspace step, R1-R3, R6. Fixes the "Can't reach" dead end on its own.
2. Setup link, R4-R5.
3. Sign-in and Dictate in one trip, R7-R9.
4. Permissions and Done steps in the same window, R10-R12.

## Support materials to update

Landing page Mac app window (hotsauce.work), install.md, README Mac section, docs/self-host.md,
/dictate page copy, demo mocks for the download page, the Mac app loop video, screenshots.

## Not in this plan

Finding a workspace from a work email address (needs a directory or DNS convention). Apple Developer
ID signing (still deferred).
