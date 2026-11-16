# Status

What Hotsauce is today, read from the code on `main` at release 0.15.0 (2026-11-16). Each app is
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
The home page: clock, next meeting, optional weather, and tiles you arrange (meetings, tasks, to-dos from notes, changed docs, agent brief).
Needs nothing extra; the agent brief tile needs the AI key, the weather needs the member's location.

### Docs
Markdown documents with a source-first editor, live co-editing, history from Git, links that survive renames, search, and imports (Markdown, Word, HTML).
Needs nothing extra.

### Meetings
Notes for calls: live transcript with speaker names, your own notes, AI-written notes from templates, Ask across meetings, booking links, phone voice notes, Granola import.
Needs the speech and AI keys; the calendar needs Google sign-in through Clerk with `calendar.readonly`; booking links need Turnstile. Reminders work out of the box (the server makes its own push keys).

### Dictate
Hold a key on the Mac, talk, and clean text lands at the cursor, with team word lists. The web page sets up the Mac app.
Needs the speech and AI keys and the Mac app (`apps/dictate-mac`).

### Clips
Screen and camera recordings with a transcript, Summarize and Action items, speed control and a shared library.
Needs the speech and AI keys and `ffmpeg` on the server; video lives on the volume or in R2/S3.

### Tasks
Quick-add tasks with projects, recurrence and reminders; Ramble turns a voice note into tasks; Todoist import.
Needs nothing extra; Ramble needs the speech and AI keys.

### Notes
Colored note and checklist cards with labels, pins and an archive; Google Keep import.
Needs nothing extra.

### Boards
The Whiteboard: hand-drawn boards the team draws on at once, one file per board.
Needs nothing extra.

### People
Everyone you meet with, from the calendar and meeting notes, with a short team note about each person.
Needs the Google calendar connection to fill itself; without it, only meeting attendees and task assignees.

### Files
Upload and share files and folders with previews and search inside them; Git keeps a pointer, the bytes live elsewhere.
Needs nothing extra on the server's volume; R2/S3 when configured.

### Forms
Surveys, sign-ups and requests for the team or anyone with the link; answers land in Git.
Needs nothing extra for members; forms open to outside people need Turnstile.

### Check-ins
A question the team answers on a schedule, with replies and one AI summary posted to a chat room.
Needs nothing extra; the summary needs the AI key, posting it needs a chat room's webhook.

### Tables
Trackers with spreadsheet formulas, kept as CSV in Git.
Needs nothing extra.

### Links
A read-later list: save from the Chrome extension, phone or app, read a clean copy, keep the page as you saw it.
Needs nothing extra; the AI summary needs the AI key.

### Briefcast
A five-minute spoken briefing each weekday morning, as a private podcast feed.
Needs the AI key for the script and `OPENAI_API_KEY` with `TTS_PROVIDER=openai` for the voice.

## Built into every app

- **Ask** (⌘J): the assistant on every page, with the same tools as the MCP server, as the member. Needs the AI key; admins set the model and a monthly limit.
- **Agent briefs**: a nightly page per member from their meetings and tasks. Needs the AI key.
- **Share pages** (`apps/web/src/apps/pages`): read-only links and published pages. Needs nothing extra.
- **Chat** in the rail is a link to the organization's own chat (`CHAT_URL`), not a Hotsauce app.
- **Send feedback** files a GitHub issue. Needs `FEEDBACK_REPO` and `FEEDBACK_GITHUB_TOKEN`.
- **Updates**: the server checks for a new release hourly and, on Fly, updates itself (needs `FLY_API_TOKEN`).
- **Backups**: nightly copies of the data to R2/S3 (14 daily, 8 weekly) whenever a bucket is set.

## Outside the web app

- **Mac app** (`apps/dictate-mac`), 0.14.4: Dictate, meeting recording with call detection, Today's weather, the Go menu. Self-signed, not notarized, so macOS asks once to open it.
- **Chrome extension** (`apps/extension`), 0.7.0: records Meet tabs, saves links in one click, connects in one click. In Chrome Web Store review; installed by hand until approved.
- **Cloudflare** (`apps/cloudflare`): the Worker that runs Hotsauce on Cloudflare (one-click deploy). It needs GitHub repos and R2 for media; "On this server" storage is hidden there.
- **MCP server** (`/mcp`, `docs/mcp.md`): any AI tool that sends a token header can search, read and write as the member. ChatGPT and Grok need OAuth, which is in flight.
- **Site** (`site/`): hotsauce.work, the help center, install guide and the live demo at demo.hotsauce.work.

## Built but switched off by default

Each of these is in the code and stays off until the instance gives it what it needs, on purpose:
production refuses the test stand-ins, so nothing pretends to work.

| What | Off until | Why it's off |
| --- | --- | --- |
| Briefcast's voice | `OPENAI_API_KEY` and `TTS_PROVIDER=openai` | The only paid voice; the script is still written without it. |
| Booking links and public Forms | `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` | Pages open to anyone need a robot check; without it they say they can't take answers yet. |
| Send feedback | `FEEDBACK_REPO` and `FEEDBACK_GITHUB_TOKEN` | Needs a repo to file into. |
| Kept meeting audio and the after-call re-transcription | `KEEP_AUDIO` with `AUDIO_STORE` | Audio is big and personal; the default keeps only the transcript. |
| Self-update | `FLY_API_TOKEN` (Fly only) | Other hosts update by pulling the new image. |
| Semantic search | not wired | `sqlite-vec` is loaded but unused; search and Ask use keyword search. |

## In flight

Open pull requests on `main` at the date above (release numbers are taken at merge, not here):

- **#98** Links remembers where you stopped reading (the second step of the Links roadmap).
- **#102** Offline mode, step A: opens offline and never loses a save.
- **#106** Settings as a few small pages.
- **#108** Sign in to the MCP server from claude.ai, ChatGPT and Grok (OAuth).
- **Chrome Web Store** review of the extension (not a PR; waits on Google).
- **A notarized Mac app** waits on an Apple Developer account.

Next on the Links roadmap after #98: highlights and notes inside the link's file, then PDFs and papers.
