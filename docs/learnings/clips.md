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
