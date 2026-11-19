# Status

What Hotsauce is today, read from the code on `main` at release 0.28.0 (2026-11-16). Each app is
two lines: what it does, and what it needs beyond the base install. Keep this file current in the
same PR as any change to an app; `apps/web/src/apps/statusDoc.test.ts` fails when an app exists in
the code but has no entry here.

**The base install** every app relies on: one Hotsauce server (Docker on Fly or your own machine,
or Cloudflare Workers with a container), Clerk sign-in, and a place for the Git repos (the server's
own volume, GitHub or Forgejo). `ANTHROPIC_API_KEY` turns on the AI parts and `DEEPGRAM_API_KEY`
turns on speech. Without them the apps still open and keep files; the AI and speech buttons say
they aren't set up. Keys can be set in the environment or pasted into setup; the environment wins.

## The apps (the rail, in order)

### Today
The home page: clock, next meeting, a sky behind the greeting that follows the time of day with the sun or moon and today's sunrise and sunset (Sky, Sun path or Off per device, plus a "Follow the sun" look for the whole app; `docs/PLAN-today-sky.md`), optional weather (click it for the next 12 hours and 7 days), and tiles you arrange (meetings, tasks, to-dos from notes, changed docs, agent brief). A new member's Today starts with a Getting started tile (connect the calendar, get the Mac app, see the docs) that goes once done or hidden, and comes back from Settings. An admin can pick the doc its last step opens (Settings → Workspace).
Needs nothing extra; the agent brief tile needs the AI key. Weather uses the team's place, or one the member picks or shares; a shared location is named after the town it's in (OpenStreetMap's Nominatim, through the server, rounded to ~1 km, cached).

### For you
One list of every comment where someone @mentioned you on a doc, meeting note or task, newest first, with a count on the rail (on the phone, on For you if it's on the tab bar, else on Today, else a dot on Apps) and a Today tile. Opening one marks it read; Done takes it off until you're mentioned there again; Later hides it until 9 AM tomorrow or next Monday. Replies, assigned tasks and the Mac dock count come next.
Needs nothing extra; Done and Later are kept in your personal space.

### Docs
Markdown documents with a source-first editor, live co-editing, history from Git, links that survive renames, search, and imports (Markdown, Word, HTML).
Needs nothing extra.

### Meetings
Notes for calls: live transcript with speaker names, your own notes, AI-written notes from templates, Ask across meetings, booking links, phone voice notes, Granola import.
Needs the speech and AI keys; the calendar needs Google sign-in through Clerk with `calendar.readonly`; booking links need Turnstile. Reminders work out of the box (the server makes its own push keys). Keeping a meeting's audio is a per-meeting choice (`KEEP_AUDIO=true` makes it the default); re-transcribing it after the call needs the speech key.

### Dictate
Hold a key on the Mac, talk, and clean text lands at the cursor, with team word lists. The web page sets up the Mac app. With no connection, the Mac app writes up dictation with the Mac's own speech recognition (as spoken, the Mac's language, audio never leaves the Mac; `docs/PLAN-offline.md` step A2). The Dictate page's Models section shows the speech, offline and cleanup models, each member picks Fast, Careful or Off for the cleanup, and Online or "On this Mac only" for the Mac app's speech (the Mac writes it up itself and sends only text; the server refuses a Mac's audio for that member) (`docs/PLAN-dictate-models.md`).
Needs the speech key and the Mac app (`apps/dictate-mac`); the AI key turns the raw transcript into clean text.

### Clips
Screen and camera recordings with a transcript, trimming, Summarize and Action items, speed control, a shared library and read-only links for people outside.
Needs the speech and AI keys and `ffmpeg` on the server; video lives on the volume or in R2/S3.

### Tasks
Quick-add tasks with projects, recurrence and reminders; Ramble turns a voice note into tasks; Todoist import.
Needs nothing extra; Ramble needs the speech and AI keys.

### Notes
Colored note and checklist cards with labels, pins and an archive; Google Keep import.
Needs nothing extra.

### Boards
Boards: hand-drawn boards the team draws on at once, one file per board.
Needs nothing extra.

### People
Everyone you meet with, from the calendar and meeting notes, with a short team note about each person.
Needs the Google calendar connection to fill itself; without it, only meeting attendees and task assignees.

### Files
Upload and share files and folders with previews and search inside them; Git keeps a pointer, the bytes live elsewhere. A file can carry a date it deletes itself on (shown on its row, with Keep to stop it).
Needs nothing extra on the server's volume; R2/S3 when configured.

### Forms
Surveys, sign-ups and requests for the team or anyone with the link; answers land in Git.
Needs nothing extra for members; forms open to outside people need Turnstile.

### Sign
Send a PDF from Files for signature: list who signs (inside or outside the team, all at once or in order) and who only gets a copy, place each person's fields, and send. Each signer gets their own link (30 days, no account), signs or declines with a reason, and the sender follows each person's state, can make a new link, and can fix a wrong name or address before someone signs (their old link stops; the correction is in the audit trail). Any sent envelope can be copied into a new draft with the same PDF, people and fields. When the last person signs, a sealed copy (a PAdES seal any PDF reader can check) and its audit certificate land in Files beside the original and are emailed to everyone on it. Not yet: deadlines, reminders, cancelling, templates. They are the next Sign work (docs/PLAN-sign.md slices 4 and 5), not yet started.
Needs nothing extra to sign: the server makes its own seal key on first use. Emailing links and copies needs `RESEND_API_KEY` and `MAIL_FROM`; without them Send shows each link to copy.

### Check-ins
A question the team answers on a schedule, with replies and one AI summary posted to a chat room.
Needs nothing extra; the summary needs the AI key, posting it needs a chat room's webhook.

### Tables
Trackers with spreadsheet formulas, kept as CSV in Git.
Needs nothing extra.

### Links
A read-later list: save from the Chrome extension, phone or app, read a clean copy, keep the page as you saw it. PDFs (from an address, or added from your computer) are kept in Files with a readable copy of their text; arXiv, bioRxiv and medRxiv papers get their authors, abstract, version and DOI. Remembers where each person stopped reading and shows how much they've read. Highlights and notes on a page (kept in the link's file, read by search, Ask, Briefcast and AI tools), a Highlights tab, and Copy highlights to a Doc. Links an AI tool saves wait for the member to press Get the page.
Needs nothing extra; the AI summary needs the AI key.

### Briefcast
A five-minute spoken briefing each weekday morning, as a private podcast feed.
Needs the AI key for the script and `OPENAI_API_KEY` for the voice (it also needs an audio store, which every install has unless `AUDIO_STORE=none`).

## Built into every app

- **Ask** (⌘J): the assistant on every page, with the same tools as the MCP server, as the member. Needs the AI key; admins set the model and a monthly limit.
- **Comments and @mentions**: a conversation under every team doc, meeting note and task; `@` and a name sends that teammate one notification that opens on the comment. Needs nothing extra; notifications must be on for the push. Not yet: a "For you" list, replies and comments from AI tools (the next steps in `docs/PLAN-comments.md`), and sending a comment written offline.
- **Offline (step A)**: once opened on a device, the app opens there with no connection, as the last member signed in, with an Offline bar; what needs the server is greyed out or says "Not available offline yet". Doc edits made offline are kept on the device ("Saved on this device") and sent when back, even after a reload; text the server refuses (the doc moved) is kept in Docs → Kept on this device. Sign out works offline. Needs nothing extra. Not yet: reading docs, tasks and notes not edited offline (step B in `docs/PLAN-offline.md`), new docs made offline.
- **Agent briefs**: a nightly page per member from their meetings and tasks. Needs the AI key.
- **Share pages** (`apps/web/src/apps/pages`): read-only links and published pages. Docs, meeting notes, notes, pages, clips and files can have a read-only link; each link is for members or for anyone with the link (anyone links need the admin switch in Settings → People and access, off by default) and ends after 7 days, 30 days (default) or never. Admins see and turn off every link there. Needs nothing extra.
- **Your apps on the rail and the phone tab bar** (`docs/PLAN-pinned-rail.md`, `docs/PLAN-phone-tab-bar.md`): each member pins any apps to the desktop rail from its grid button, and picks up to five for the phone's bottom bar from Apps → Edit tab bar; two separate lists, kept per member on the server. Needs nothing extra.
- **The rail and the account menu** (`docs/PLAN-rail-account-menu.md`): the logo at the top of the desktop rail widens it so each icon has its name beside it (kept per device); resting on an entry says what the app is for and its shortcut. The account button at the foot opens a menu with Light, Dark and Auto, Music, Breaks, Settings, Keyboard shortcuts, Help, Send feedback and the versions (Hotsauce's and, in the Mac app, the app's). A member adds a profile photo there or in Settings → General; it's kept in the account store. Not yet: photos shown to other members, the sign-in photo as a default. Needs nothing extra.
- **Background music** (`docs/PLAN-background-music.md`): Music in the account menu (Apps → Music on phones) plays one of four CC0 tracks (`apps/web/public/music/`, credits at hotsauce.work/help/music), off until the member turns it on, remembered per browser, held while the page records. Getting started offers it once. The Mac app plays and pauses it from its menu bar and Music menu and holds it while it dictates or records a call. Needs nothing extra.
- **Screen breaks** (`docs/PLAN-breaks.md`): Breaks in the account menu and Settings → General remind a member to look away from the screen (every 20 minutes for 20 seconds to start; 5 to 120 minutes, 10 seconds to 15 minutes), with a 10-second heads-up, a calm full-screen break (breathing circle, clouds or waves), Skip and 5 more minutes, an end chime and optional working hours. Off until the member turns it on; Getting started offers it once. Kept in their personal space (`.hearth/breaks.json`), so every device follows. Waits while recording, dictating, screen sharing or in a calendar meeting with others; time away counts as a break. One browser tab shows it; the Mac app keeps the timer itself and shows it over every display with the window closed. Needs nothing extra.
- **Chat** in the rail is a link to the organization's own chat (`CHAT_URL`), not a Hotsauce app.
- **Chat as context** (`docs/PLAN-chat-context.md`): an admin switches on **Read for context** for a chat room in Settings → Workspace whose link is a bot's room address (Ember, Campfire). Hotsauce copies its history into `DATA_DIR/chat.sqlite`, reads new messages every 5 minutes (`CHAT_READ_INTERVAL_MS`) and thread replies of the last week, and the messages show in ⌘K (In chat), Ask and AI tools (`search_chat`, `read_chat`) and the agent brief. Every member can search a read room; direct messages are never read; later edits and deletions aren't picked up. Needs nothing extra beyond the bot in the chat.
- **Send feedback** files a GitHub issue. Needs `FEEDBACK_REPO` and `FEEDBACK_GITHUB_TOKEN`.
- **Updates**: the server checks for a new release hourly and, on Fly, updates itself (needs `FLY_API_TOKEN`), installing only the exact image each release recorded.
- **Picking up a new release in open windows** (`docs/PLAN-reload-after-updates.md`): a window left open (the Mac app's window, a pinned tab) asks the server for its release every 10 minutes and when it comes back to the front, and reloads into a new one at a safe moment (in the background, after 2 minutes untouched, or on moving to another page), never while recording, dictating, typing or with something unsaved; then says "Hotsauce updated to X". Needs nothing extra.
- **Backups**: nightly copies of the data to R2/S3 (14 daily, 8 weekly) whenever a bucket is set.
- **The welcome tour and Hotsauce 101** (`docs/PLAN-tour-and-101.md`): the first time a member opens Hotsauce on a computer (web or Mac app), a welcome card offers a short tour of a dozen stops (Driver.js, MIT, loaded only when it runs); seen once per account (`tour_seen` in `account.sqlite`), never on a phone, never while recording. **Take the tour** in the account menu or ⌘K replays it. Settings → Hotsauce 101 has a card per app from `site/public/apps.json` (the same list as hotsauce.work's windows) with its looping video bundled into the app (about 4 MB, fetched only on click), whether it's ready here, and Open; "What is Tables?" in ⌘K opens a card. Needs nothing extra.
- **What's new** (Settings → What's new, from the version under the Settings menu): plain release notes, newest first, from `WHATS_NEW.json`, which the Release workflow fills from each pull request's "What's new" section. Also at hotsauce.work/changes. Needs nothing extra.
- **Settings search** (the box above the Settings menu, or `/` on a Settings page): finds any section by its name or everyday words and opens it on its page; the same sections are in ⌘K once typed. One list, `apps/web/src/routes/settings/searchIndex.ts`; a test fails if a listed section is missing from its page. Needs nothing extra.
- **Themes of your own** (Settings → Appearance, its own page, `docs/PLAN-ai-themes.md`): a member describes a look and the whole app previews it; Keep saves it beside System, Light and Dark. Colours and fonts only, one fixed light or dark look, text kept readable by `fixContrast` (`@hotsauce/format`). Themes are personal, kept in the account store (`account.sqlite`, backed up), at most 12 a member; which look is on stays per browser. Uses `THEMES_MODEL` (default Sonnet); without an Anthropic key the box is hidden and saved themes still work. The live demo answers with sample themes.
- **Tool-switch ripple** (Settings → Appearance, `docs/PLAN-switch-ripple.md`): opening another tool sends a liquid wave from the click (or that tool's rail icon) across the whole window in about 0.75 s: an SVG displacement filter on the app root bends the page as a band of light rides the front. Never blocks the page; a device that can't keep up falls back to the light band alone (`hotsauce:switch-wave-slow`). On by default, skipped under reduced motion. An optional soft tick (off by default) is made in the page with Web Audio and stays silent while a meeting records or any capture is open. Both choices are per browser (`hotsauce:switch-fx`). The Mac app gets it through its web view.
- **Easter eggs** (`apps/web/src/eggs`, `docs/PLAN-easter-eggs.md`): hot sauce surprises, undocumented on purpose (the list is in the plan). Quick, never blocking, still under reduced motion, sound only with the tool-switch tick on. Unknown addresses show a lost-sauce page with a way to Docs. The Mac app's Option-held About item starts the pepper shower. Needs nothing extra.
- **Usage** (Settings → Usage, admins): each app's items made or changed and people per week for 12 weeks, counted from Git history, Clips' list and Dictate's connected Macs. Nothing is tracked; numbers only. Needs nothing extra.

## Outside the web app

- **Mac app** (`apps/dictate-mac`), published as one GitHub prerelease per build (`mac-app-<build>`; servers take the highest): Dictate, meeting recording with call detection, Today's weather, the Go menu. Self-signed, not notarized, so macOS asks once to open it. Settings → Apps shows each Mac's version and whether an update exists (from `mac-app.json` on the newest release); the app updates itself: it downloads a newer build quietly, accepts it only when it satisfies its own code signature requirement, sends one notification, and swaps itself and relaunches on "Restart to update" (menu bar, notification or Settings → Apps), falling back to the download when it can't (`docs/PLAN-mac-self-update.md`). hotsauce.work/download/mac always hands out the newest build, and the landing page shows its version (`site/mac-download.js`, `docs/PLAN-mac-download.md`). GitHub builds the app after every release whose version or Mac sources changed (`.github/workflows/mac-app.yml`), once its signing secrets are set; a build that only carries a new number offers no update. Its settings are one page of the web app, Settings → This Mac, shown only inside the app (`docs/PLAN-one-settings.md`), and its dictation numbers and history are the Dictate page's "On this Mac" (`docs/PLAN-dictations-page.md`).
- **Chrome extension** (`apps/extension`), 0.7.0: records Meet tabs, saves links in one click, connects in one click. In Chrome Web Store review; installed by hand until approved.
- **Cloudflare** (`apps/cloudflare`): the Worker that runs Hotsauce on Cloudflare (one-click deploy). It needs GitHub repos and R2 for media; "On this server" storage is hidden there.
- **MCP server** (`/mcp`, `docs/mcp.md`): any AI tool can search, read and write as the member, either by signing in (OAuth, used by claude.ai, ChatGPT and Grok) or by sending a token header. A sign-in can be **Team space only, read only**, for a tool many people share, like a team chat's assistant (`docs/PLAN-team-connection.md`).
- **Site** (`site/`): hotsauce.work, the help center, install guide and the live demo at demo.hotsauce.work.

## Built but switched off by default

Each of these is in the code and stays off until the instance gives it what it needs, on purpose:
production refuses the test stand-ins, so nothing pretends to work.

| What | Off until | Why it's off |
| --- | --- | --- |
| Briefcast's voice | `OPENAI_API_KEY` | The only paid voice; the script is still written without it. |
| Booking links and public Forms | `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` | Pages open to anyone need a robot check; without it they say they can't take answers yet. |
| Send feedback | `FEEDBACK_REPO` and `FEEDBACK_GITHUB_TOKEN` | Needs a repo to file into. |
| Self-update | `FLY_API_TOKEN` (Fly only) | Other hosts update by pulling the new image. |
| Semantic search | not wired | `sqlite-vec` is loaded but unused; search and Ask use keyword search. |

## In flight

Open pull requests on `main` at the date above (release numbers are taken at merge, not here):

- **#134** For you: one list of every mention.
- **Screenshots in the Mac app** (`docs/PLAN-screenshots.md`): the server and web half is in (files that delete themselves, and the page function the app shares through); the Mac app's capture, editor and Share are being built.
- **Chrome Web Store** review of the extension (not a PR; waits on Google).
- **A notarized Mac app** waits on an Apple Developer account.

Next on the Links roadmap: newsletters by email (PDFs and papers shipped).
