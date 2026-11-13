# Plan: install on your phone, and a tidier Settings

## Status

In progress on branch `feat/install-prompt-settings` (draft PR). Shared files touched: `apps/web/src/components/AppRail.tsx` (account menu), `apps/web/src/components/AppsSheet.tsx`, `apps/web/src/components/AppShell.tsx` (the install bar sits above the shell), `apps/web/src/routes/SettingsRoute.tsx`, `apps/server/src/api/meetings.ts` (one new route).

## Decisions

- The install bar shows on phones and tablets only, in the browser (never in the installed app), once per browser until dismissed. ✕ hides it for good on that browser.
- Android and other Chromium browsers get the browser's own install dialog. iPhone and iPad Safari, and every browser without one, get a short how-to sheet.
- Settings, top to bottom: Account, Install app, Notifications, Appearance, Mac app and Chrome extension, Connect Claude, Calendars, Help, About. Admins still see the Organization link first.
- Sign out lives in Settings only (Account card). Neither the phone Apps sheet nor the desktop account menu has it; the account menu gets a Settings item instead (Morgan, 2026-11-13).
- One "Notifications on this device" switch covers everything pushed to a browser: meeting and task reminders, check-in questions and the daily briefing all go to the same subscription.
- "Send test notification" is `POST /api/meetings/reminders/test`, next to the existing subscribe and unsubscribe routes, and sends through the same push sender.
- About shows the server's version (from `/api/health`) and a Reload button. Updates already apply on their own (`registerType: 'autoUpdate'` with `skipWaiting`), so there is never a waiting update to offer; Reload asks the service worker to check and reloads.
- Account shows initials, not a photo: the session carries no picture today.

## Requirements

Each requirement maps to a test, named in brackets.

**Install bar**

- I1: `installContext()` says a phone or tablet when the main pointer is coarse and the screen is narrow, or the user agent is a phone or tablet; iOS when the user agent is iPhone, iPad, or an iPad that reports itself as a Mac with touch; installed when `display-mode: standalone` matches or `navigator.standalone` is true. [install.test]
- I2: `useInstallPrompt()` captures `beforeinstallprompt` (kept in one shared module, so a prompt that fired before the component mounted still counts) and reports `canPrompt`; `prompt()` shows the browser's dialog and reports the outcome; `appinstalled` marks it installed. [install.test]
- I3: The bar "Install {product} on your phone" shows on a phone or tablet, not installed, not dismissed. It never shows on a computer or in the installed app. [InstallBar.test]
- I4: ✕ hides the bar and remembers it in localStorage; a later visit shows nothing. Storage that throws still hides it for this visit. [InstallBar.test]
- I5: Install with the browser's prompt available shows that prompt. On iOS it opens a sheet with two steps (Share, then Add to Home Screen). With no prompt and not iOS, the same sheet with generic wording. [InstallBar.test]
- I6: On a phone, the bar shows on first visit, opens the how-to sheet, and ✕ keeps it away after a reload; nothing is wider than the screen. [e2e install-mobile.spec]

**Settings**

- S1: Settings shows its sections in the order above. [SettingsRoute.test]
- S2: The Account card shows the member's name and email, and Sign out signs out (forgetting reminders on this browser first, as before). [SettingsRoute.test]
- S3: Install app shows an Install button on a browser, and "Installed" in the installed app. [SettingsRoute.test]
- S4: Help links to Send feedback when feedback is on, the help center (hotsauce.work/help) and the FAQ (hotsauce.work/faq). About shows the server's version and a Reload button. [SettingsRoute.test]
- S5: The Mac app and Chrome extension card links to the extension page. [SettingsRoute.test]

**Sign out and menus**

- M1: The phone Apps sheet has no Sign out. [AppsSheet / app-rail test]
- M2: The desktop account menu has Settings and no Sign out. [AppRail.test, e2e app-rail.spec]

**Notifications**

- N1: The switch shows each state with plain words: not supported (iPhone: add to Home Screen first), not set up on this server, blocked in the browser, off, on. Turning it on and off goes through the existing reminders module. [Notifications.test]
- N2: `POST /api/meetings/reminders/test` sends a test notification to each of the caller's subscriptions and none of anyone else's, forgets ones the push service says are gone, answers `{ sent }`, refuses a token (session only) and says so plainly when push isn't set up. [integration meetings.test]
- N3: "Send test notification" shows how many devices it went to, or that none are subscribed. [Notifications.test]
- N4: Meetings no longer has its own reminder checkbox; it links to Settings. [MeetingsHome test]

**Support material**

- D1: The demo's mock API answers the new route; README, self-host and the landing page describe install and notifications where they mention them.
