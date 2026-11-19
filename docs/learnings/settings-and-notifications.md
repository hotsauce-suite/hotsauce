# Learnings: installing the app, Settings and notifications

- **One push subscription feeds four things.** Meeting reminders, task reminders, check-in questions and the daily briefing all send through `meetings.reminderStore`. Any switch or copy about "notifications" covers all of them; naming only reminders misleads people who turn it off.
- **`beforeinstallprompt` fires once, early.** It can come before any React component mounts, so `lib/install.ts` listens when the module loads and keeps the event. A prompt can only be shown once; drop it after `prompt()`.
- **iPadOS says it's a Mac.** Detect iPad as `Macintosh` plus `navigator.maxTouchPoints > 1`. jsdom has no `maxTouchPoints`; tests set it with `Object.defineProperty` (`src/test/devices.ts`).
- **Spying on `matchMedia` twice in one test recurses** if the second spy wraps the first. Keep a bound copy of the real one at module load.
- **The service worker registers after load.** A first visit straight to `/settings` can ask for the registration before it exists and wrongly call the browser unsupported; `reminderState()` waits up to 3 s for `serviceWorker.ready`.
- **A send that throws isn't "no device".** The test-notification route counts failures separately so the page can say "couldn't reach" instead of "not set up".
- **Live regions must exist before their text changes.** A `role="status"` element inserted already filled is often not announced; render it empty and change its text.
- **The demo has no service worker**, so install prompts and the Settings install card are hidden when `import.meta.env.MODE === 'demo'`.
- **Several threads share `/Users/morgz/code/hotsauce`.** Work in your own `git worktree` from the start; otherwise another thread can switch the branch under you.

## Install section and Mac notifications (2026-11-14)

- **WKWebView has no `Notification` API at all**, so the browser path always lands on
  "unsupported" inside the Mac app. Detect the app by its bridge
  (`webkit.messageHandlers.hearthNotifications`), not by the user agent, and let the app answer
  with macOS's own state; an older app without the bridge keeps the old note.
- **Re-read the state on `focus`.** The member changes it in System Settings, outside the page,
  so the card would otherwise stay stale until a reload.
- **Moving a section into another keeps its anchor working** as long as the `id` moves with the
  card: `#mac-app` is on the Mac app card inside Install, and the e2e checks it lands in view.

## Settings as pages (2026-11-15, docs/PLAN-settings-pages.md)

- **Crowding was weight, not count.** The first pass counted sections and proposed ten pages. Reading every screen showed two blocks (the Mac app's install guide, the AI tools intro) took most of the height. Trim before regrouping, and judge a settings screen by what fills it.
- **A layout route swallows the outlet context.** `KeyboardSettings` reads the shell from `useOutletContext`; once a `SettingsLayout` sat between it and `AppShell`, it got nothing. A layout that renders `<Outlet />` must pass the parent's context on (`<Outlet context={useOutletContext()} />`).
- **`NavLink` needs `end` when one page's address is a prefix of another's** (`/settings` and `/settings/apps`, `/settings/organization` and `…/brand`), or two items show as current.
- **One route component for sibling pages keeps shared state.** `organization/:page?` is one route, so React keeps `OrgSettingsRoute` mounted and the "apply to restart" banner survives moving between organization pages. Five separate routes would have dropped it.
- **Splitting a form across pages means splitting its save.** "Your organization" sent every field on each save. Shown on three pages, each would have saved the other two pages' stale copies; `part` narrows both the fields and the payload. The server already merged partial patches.
- **Settings is listed in two routers**: `router.tsx` and `test/renderApp.tsx`. They now share `routes/settings/routes.tsx`. A page added to only one passes tests and 404s in the app, or the reverse.
- **Old hash addresses are an API.** The Mac app, Today, Dictate, emails and help pages all linked `/settings#mac-app`. `movedSection` redirects them; add a line there when a section changes page.
- **Never `git checkout <file>` to undo a throwaway edit on uncommitted work.** Commit first, then experiment.

## Usage page (2026-11-16)

- **Git already answers "who used what, when".** `git log --name-status -z` per clone is
  enough; no event tracking needed. Use `--find-renames` or every move looks like a new item.
- **Every new space seeds a README authored by the member**, not by Hotsauce, so filtering on the
  committer's address alone counts one Docs "creation" per person. Skip the
  `hotsauce: create space` commit by its subject.
- **Not every app writes to Git.** Clips live in SQLite (count `created_at`), Dictate's history
  never leaves the Mac (only `last_used_at` per device exists), Today writes nothing. Say so on
  the page instead of showing a zero that reads as "unused".
- **fast-check isn't a dependency yet.** Adding it touches the lockfile, a shared file; the pure
  report got example tests instead.
- **Don't use `git log --since`.** It stops walking at the first run of commits with older
  committer dates, so old-dated commits on top (an import, an outside push) hide recent work.
  Walk the history and filter by author date.

- **A side menu inside a scrolling page must be made to stay.** The first Settings layout put the
  menu and the page in one scrolling grid, so the menu left with the page. Wrapping the menu and
  the help strip in one sticky box fixes it; on phones the same box is `display: contents` and
  `order` puts the help strip after the page, so one set of elements serves both layouts. When
  testing it, measure the menu against the scrolling area and poll: the page's entrance and late
  fonts move things a few pixels for the first moments.

## Settings search (2026-11-17)

- **Find sections by their heading text, not new ids.** Most Settings sections had no `id`, and
  adding one to each would have touched a dozen shared components. The result carries the heading
  in router state (`settingsFind`), and the layout finds the `h2`/`h3`/`legend`/card title that
  matches. A test renders every page and checks each listed heading is there, so a renamed
  heading fails CI instead of quietly breaking search.
- **Keep the page mounted under the results** (`hidden`), so a half-typed form on the page
  survives a search.
- **The layout's "new page scrolls to top" effect fights a jump to a section**: skip it when the
  location carries `settingsFind`, and keep re-scrolling for a few seconds as lazy sections load.
- **Watch prefixes in the everyday words**: "logout" made "logo" find Account. Every typed word
  matches the start of a word, so one-word synonyms leak; prefer two-word phrases.
- **A long list of ⌘K rows can be `typedOnly`**: they match once something is typed and stay out
  of the empty menu.

## The Mac app's settings live in web Settings (This Mac, Nov 17)

- A native settings window beside the web app's Settings confused people more than any single
  setting did. One Settings, with a Mac-only page fed by a WKWebView bridge, costs little: the page
  is ordinary React tested against a fake bridge (`apps/web/src/test/fakeMac.ts`), and the Swift side
  is a pure parser plus a snapshot in DictateCore that runs in `swift test` without a window.
- Have every bridge answer with the whole snapshot, and render what came back, not what was asked.
  Native confirms (history retention, Clear history) can be cancelled, and the page then shows the
  truth with no extra code.
- A new Mac build can meet an older web app (self-hosted servers update on their own schedule). The
  page says hello over the bridge on boot; the app routes ⌘, to the page only after that hello and
  keeps a small native fallback otherwise. Reset the flag in `didCommit`, before the new document's
  scripts run.
- WebKit hands JS booleans and numbers over as NSNumber. Check `CFBooleanGetTypeID` to tell a real
  `true` from `1`, or strict parsing silently accepts the wrong type.
- No Swift toolchain in the cloud container: write the Swift, then compile and `swift test` on m5Box
  in a throwaway worktree. Installing test builds there resets Morgan's permissions; it isn't needed
  to check a build.
- The PR's "check" job (macOS runner, `swift test` and a release build) compiles the Swift for you
  now, so a cloud thread can change the Mac app without m5Box: push early and let CI be the compiler.
- To add a second page to an existing bridge, send a second hello (`helloDictations`) rather than
  growing the first: strict parsing in older apps would refuse a hello with extra keys and lose
  the original routing.
- Anything the sidebar links to inside the Mac app should appear only after the app has answered,
  not when the bridge merely exists: older apps have the handler but not every request.
- Let the Mac compute numbers it already computes (DictationStats, MonthActivity) and send them;
  porting the sums to TypeScript would give two answers to one question.

## Themes from a prompt (2026-11-18)

- Don't trust a model's colours: run every answer through `fixContrast`. Pushing backgrounds to their scheme's end first (luminance ≥ 0.4 light, ≤ 0.05 dark) is what makes "any palette reads" provable; without it a mid-grey paper can leave no foreground that reaches 4.5 against all three papers.
- A custom theme has to beat both tokens.css's dark-mode rule (`:root:not([data-theme=light])`) and the brand's `:root` style. `html:root[data-theme="custom"]` has one more element in its specificity than either, so source order stops mattering.
- To avoid a flash of the old look on reload, cache the finished CSS string, not the theme JSON: `index.html`'s inline script can't import the code that turns one into the other.
- Be lenient where the model slips harmlessly (3-digit hex, long names, odd font names fall back) and strict where the browser sends it back (the API validates the theme exactly).
- e2e here needs `PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium` in the cloud container; the pinned Playwright's headless shell isn't installed.
- The Mac app (and any long-open tab) can show the server's new version number under Settings while still running the old web code: the number comes from `/api/health`, the code from the cached build. "Reload" under the version is the fix to give people; don't assume a new feature is missing just because the old screen is showing.
- Giving a section its own Settings page touches five places: `pages.ts` (menu), `routes.tsx`, the page component, `searchIndex.ts` (its `to`), and `MOVED` for old `#section` addresses. The menu-order tests in `settingsPages.test.tsx` list every page, so they fail loudly when one is added.
- Free outside services shared by every self-hosted copy (Nominatim, MET) block by User-Agent, so one busy instance can get all of them blocked. Throttle server-wide, share in-flight lookups, back off after a failure (longer after 403/429), and cap the queue so a stall answers at once instead of piling up.
