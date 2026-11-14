# Learnings: making the tour video

Notes from recording the hotsauce.work tour (scripts in `scripts/tour-video/`).

- **The in-browser mock (`VITE_MOCK_API=1`) is the best demo set.** It has believable meetings, tasks, notes and people, and it shows no fake-AI text. Apps it doesn't cover (Clips, Whiteboard, Files, Forms) fall through MSW to the Vite proxy, so a dev-auth server on :3000 behind it fills the gaps. One page then serves both.
- **The dev server's fake LLM and transcriber show on screen.** "A fake summary…", "clip segment 1" and Chromium's green test pattern all appear. For the Clips player shot, record one clip, then overwrite its `video.mp4` and its row in `clips.sqlite`.
- **Chromium's fake media devices leak their names.** The microphone picker reads "Fake Default Audio Input". With `--use-file-for-fake-video-capture`, the camera picker shows the file's path. Rename the `<option>` text before filming, or pick a mode that hides the picker.
- **Use CDP screencast, not Playwright's `recordVideo`.** Screencast frames come at the device scale factor (1600×900 at 1.2 gives 1920×1080), with timestamps, and an ffconcat file with per-frame durations keeps real timing. `recordVideo` is soft and low bitrate.
- **Homebrew ffmpeg here has no `drawtext` or `subtitles` filter.** Titles and captions are HTML pages rendered to transparent PNGs by Playwright, then overlaid with `enable='between(t,a,b)'`.
- **Time captions from Whisper word timestamps.** Splitting caption time by character count drifted by seconds. Word timings also let a montage cut on the word that names each app.
- **Sentence splitting broke the URL.** "hotsauce.work." split at the dot, and the call to action lost ".work". Protect the URL before splitting.
- **Footage longer than the voice leaves silent stretches.** Cap the speed-up at about 1.5×. When footage still runs long, start the voice later so it lands on the action.
- **Safari needs byte ranges for video.** The site worker answers `Range` on `/video/` with 206 slices and leaves HEAD alone. Without that, the dialog plays in Chrome but not in Safari.
- **An independent reviewer watching extracted frames (1 fps, tiled) caught what I missed.** It found the fake device name, the cut URL, raw Markdown in Ask citations, and silent gaps. Run that before anyone else sees a cut.

- **The Files, Whiteboard and Forms shots now run against the in-browser mock** (since the live demo got them), not the dev server. The mock searches uploaded files by name only, so the Files shot searches "budget", not a word inside the PDF.
- **The Dictate page no longer has a "Download for Mac" button**; the shot points at "Connect this Mac".
- **Stills of a custom brand need the real dev server**, because the mock's `/api/org/brand` is fixed. Start it with `ADMIN_EMAILS` and `PRODUCT_NAME`, PUT `/api/admin/org/brand` and `/api/admin/org/assets/mark` with the `x-hearth-dev-user` header, and write docs with PUT `/api/spaces/team/file`. Brand fonts come from Google Fonts, so launch Chromium with `proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost' }` and `ignoreHTTPSErrors` in the cloud sandbox, or headings fall back to a serif.
- **The meeting's Transcript button can show pressed with the panel closed on first load.** Click it twice before a still.
- **The "This week" tile only shows in the demo build** (`build:demo`, served statically), not in the `VITE_MOCK_API=1` dev server.

## Support sweep (Nov 14)

- **The Clips player shot no longer needs a real recording.** It routes `/api/clips` to a canned clip (`DEMO_CLIP` holds `composite.mp4` and `thumb.jpg`). Make the footage with the server's own `composite()` from `apps/server/dist/clips/media.js`, so the camera bubble looks exactly like the product's. The file name must contain "composite", or the player offers "Switch to it".
- **The face in the bubble is AI-generated** (a still from the OpenAI images API, `gpt-image-2`, with a slow zoompan drift), so there's no real person's likeness to clear. The API has no video model here.
- **Dev mode seeds a conflict on `plans/hiring.md`** (the live demo build skips it). A shot that opens that doc shows the conflict banner, so point shots at other docs.
- **Headless Linux shows Ctrl hints.** `rec.mjs` now sets `navigator.platform` to MacIntel, so keys read ⌘K and ⌘J like the site.
- **Check `git log` dates on `site/public/video/apps/` against the screens.** The old Clips loop still showed the Hearth flame and no camera bubble two releases later.
- **The demo mock used UTC dates for check-in rounds**, so an American evening showed tomorrow's round. Use local dates in mocks that show a day.
- **Stills are 1600×1000 (README) and 1600×1012 (site) at device scale 1**, not 1.2 like the loops. No script is committed for them: a short Playwright script per page, with `page.clock.setFixedTime` at 7:51 AM so Today says "Good morning" and the meeting is "in 1 min".
- **Two checkouts on one Mac collide on ports.** `TOUR_BASE` points `rec.mjs`, `shots.mjs` and `explore.mjs` at another Vite port, and `API_PROXY_TARGET` points Vite's `/api` proxy at another server port. `TOUR_CLOCK` (ISO time) starts a loop's clock at a fixed time, for Today.
- **`wait` in a shell that started the server with `&` waits for the server too.** Start servers in their own command, or the screenshot step never returns.
- **The default and branded Docs stills need `CHAT_URL` set** on the dev server, or the rail has no Chat pin and doesn't match the mock (which has one). The branded one also needs `PRODUCT_NAME=Fieldwork` for the "Fieldwork Docs" header; the brand used is primary `#1f6f5c`, cool neutral, the "modern" fonts and a teal mark. A doc you write with front matter keeps it and gains an `id`, so write the roadmap without front matter to get "1 property".
- **The "This week" tile isn't on the mock's default Today.** Add it in Edit Today before the still (the loop does this on camera).
