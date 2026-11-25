# Dictate: learnings

## Models and the cleanup choice (Nov 2026, docs/PLAN-dictate-models.md)

- Dictation has four ways in: the upload (`/transcribe`), the stream (`/ws/dictation`, which
  starts cleanups early in pauses through `speculate`), the web's own dictation (Check-ins,
  `DictateButton`), and Tasks' Ramble (`hear()`, no cleanup at all). A per-member setting that
  changes the cleanup belongs in `Dictation` itself (`#modeFor`, `#clean`), where all of them meet,
  not in the routes.
- The Mac already sends `mode=clean|literal` from its own menu. A member's server-side "Off" is
  applied on top of it: a literal request stays literal, and Off makes a clean one literal.
- Member state that can't be rebuilt from Git goes in `dictation.sqlite` beside the word lists.
  Add a migration at the end of `MIGRATIONS`. `schema_version` is never lowered, so a rollback
  just leaves an unused table behind.
- A radio group that saves on change must not disable itself while saving. Arrow keys change
  the selection, and a disabled radio drops the keyboard's focus to the page. Update optimistically
  and let the newest pick win.
- Show "off" for a model the server can't run (no AI key), the way Speech already says
  "Off (no Deepgram key)". Otherwise the page names a model that never runs.
- A privacy choice the Mac must honour ("keep my audio on this Mac") can't wait for a network
  answer to decide. The Mac remembers the last known choice per connection, and when it doesn't
  know yet it keeps the audio on the Mac. The server also refuses a Mac's audio when the choice is
  set, so an older app fails safe rather than sending it.
- "Tidy the text" sends words off the Mac, so Cleanup Off (or no AI key) must mean nothing at all
  is sent, not a literal cleanup on the server. Retry paths count too: the first review found a
  Retry that re-uploaded the audio.
- Swift Testing can't nest `#require` inside `#require` ("recursive expansion of macro") and the
  error shows only on the macOS CI job, never on Linux. Bind the inner value with `let` first.
- Two groups of radios saving through one endpoint each need their own "newest pick" counter, or
  a late answer for one group hides a failed save in the other.
- Sounds shared by the web and the Mac are cheapest as one small tone table synthesized on each
  side (no audio files). A test parses the Swift file so the two tables can't drift. Seeded noise
  must use arithmetic that stays exact in a JS double: Park–Miller (`* 16807 % 2147483647`) does,
  a 64-bit LCG doesn't.
- Hands-free starts with a double tap, so a start sound played on key-down fires for taps that
  never become dictations. Play it after the minimum hold, and play stop/cancel only if start
  played.
- Lowering other apps' sound: save the volume you set and put the original back only if the
  current volume is still the one you set (the member may have changed it). Persist it so a crash
  mid-dictation is undone at the next launch.
- Pressing Return after a paste must check the front app is still the one the dictation started
  in, or a "send" lands as a stray Return in whatever app the member switched to.
- A settings-search test that collects labels from the page must wait for sections that load from
  the server, not only for the Mac's reply.
