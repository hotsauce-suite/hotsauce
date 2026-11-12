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
