# Learnings: background music

- **OpenGameArt's advanced search filters by licence.** `art-search-advanced?keys=<words>&field_art_type_tid[]=12&field_art_license_tid[]=4` lists CC0 music only (type 13 is sound effects). Check each page's licence anyway: a search for "rain" turned up a GPL-2.0 loop, which an AGPL repo could ship but would muddy the credits.
- **Normalise loudness before shipping tracks.** The originals ranged from -19 dB to -34 dB mean volume, so switching track jumped the volume. `ffmpeg -af loudnorm=I=-20:TP=-2` and MP3 at 128k (96k for rain) kept all four under 9 MB together.
- **One wrapper catches every recorder.** Rather than touching Meetings, Dictate, Ramble, Clips and the extension capture, the player wraps `navigator.mediaDevices.getUserMedia` and `getDisplayMedia` once at start. A stopped track fires no `ended` event, so the hold polls `readyState` every second while a capture is open.
- **jsdom's `HTMLMediaElement.play` returns nothing.** Wrap the call in `Promise.resolve(...)` and stub `play` in component tests. userEvent can't move a range input with arrow keys in jsdom (it hangs the test until timeout); use `fireEvent.change`.
- **Browsers refuse `play()` until a click.** Music left on across a reload waits for the first `pointerdown` or `keydown` and says "Starts when you click" meanwhile.
- **`public/` files stay out of the offline cache** because the service worker's `globPatterns` only take root `*.svg`/`*.png`; a test in `music/tracks.test.ts` guards that. The Hono static server answers Range requests (206), which Safari needs for audio.

## The Mac app (2026-11-19)

- The Mac window is the web page, so the page keeps the one player and the app only remotes it: the page posts its state to a `hotsauceMusic` handler and exposes a frozen `window.hotsauceMusic`. Don't build a second player in Swift.
- The app's own dictation and call capture never call getUserMedia in the page, so the page can't see them; the app sends `hold(reason, on)` and re-sends it if the page reloads mid-recording.
- Always pass values to `callAsyncJavaScript` as arguments, never pasted into the script, and parse what the page posts strictly: any script on the page can post to the handler.
- Swift can't compile in the cloud container; the mac-app.yml workflow (macos-latest) is the compile and test gate.
