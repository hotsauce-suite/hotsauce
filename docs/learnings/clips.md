# Clips

- **A branch that was built, reviewed and green can still never ship.** The camera-as-its-own-track
  fix sat on an unmerged branch when the code moved to this repo, so the bug came back as "still
  broken". When a user reports something "still" broken, first check whether the earlier fix ever
  reached `main`, before debugging again.
- **Chrome leaves its own Document Picture-in-Picture window out of screen captures**, even
  "Entire screen" on a Mac. Anything that must appear in the recording has to be recorded as its
  own track and composited on the server; a floating window is only a preview.
- **The composite is a few milliseconds longer than the screen video** (encoder padding), so a
  duration taken from the screen video can show a second less than the player at a whole-second
  boundary. Take the duration from the file that actually plays.
- **The fake transcriber makes one line per two seconds**, so e2e checks on the transcript must not
  assume a fixed number of lines: CI machines record for different lengths.
- **The full record-to-watch journey takes 35 s or more** locally (recording, then the composite),
  past Playwright's 30 s default; it sets its own timeout.
- **Porting a stale branch:** `git diff <merge-base> <branch> | git apply --reject` onto this repo
  applied all but a few hunks; the rejects were import lines and test lines that had moved.

## Video sharpness (Nov 2026)

- "Fuzzy" had two causes stacked: a fixed 2.5 Mbit/s for every screen size, and the camera
  composite shrinking everything to 1080 p with a bilinear scaler. Check every re-encode a clip goes
  through (composite, trim), not only the recorder.
- A Retina screen is shared at its physical pixel size. `width/height: { max }` on
  `getDisplayMedia` scales it down keeping its shape; `min`/`exact` are refused.
- Base the bitrate on the track's `getSettings()` after the picker resolves, and set
  `contentHint = 'detail'` so a busy encoder drops frames rather than resolution.
- A cheap sharpness test: 2 px black and white stripes as the source, then read two neighbouring
  pixels of the output. A downscale or a soft scaler turns them grey.
- Memory measured on a full-motion 2464×1600 pattern: about 384 MB of ffmpeg at 1600 p against 237 MB
  at 1080 p. The Fly box has 1 GB and no swap, so watch for out-of-memory restarts after big clips.
- Raising the bitrate means raising the per-clip byte limit too: check that an hour at the ceiling,
  with the camera, still fits.
