# Plan: show and choose Dictate's models

## Status

- Slice 1 (server + web): built, PR #172. With no AI key the page says cleanup is off and hides
  the choice.
- Slice 2 (Mac app, "On this Mac only" speech): built; ships with the next release and its Mac
  build (built on GitHub, docs/PLAN-mac-download.md). R9 (Mac copy) is the This Mac page's.

## Why

Dictate never said which models it runs, and nobody could change them without editing the
server's environment. People should see what hears them and what rewrites their words, and pick
a different trade-off.

## Decisions (Morgan, 2026-11-16)

1. The models show as one line where Dictate's settings live: "Speech: Deepgram Nova-3 ·
   Offline: Apple, on the Mac · Cleanup: Claude Haiku 5.5".
2. Plain choices instead of a list of model ids. Cleanup is **Fast** (the default, the
   `DICTATION_MODEL`), **Careful** (`DICTATION_CAREFUL_MODEL`, default Claude Sonnet 5.5) or
   **Off** (the exact words). Speech is **Online** (the default) or **On this Mac only**.
3. Each member chooses for themselves. Everyone starts on Fast and Online.
4. With "On this Mac only", the text is still cleaned on the server unless Cleanup is Off. The
   audio never leaves the Mac.
5. Slice 1 ships the line and the cleanup choice. Slice 2 adds the speech choice with the next Mac
   build, so the choice is never offered before something honours it.

## Requirements

Slice 1:

- **R1** `GET /api/dictation/settings` returns the member's cleanup choice and the plain names of
  the models in use: speech (from `ASR_PROVIDER`), offline (Apple, on the Mac), and the Fast and
  Careful cleanup models (from the environment). A Mac's device token may call it.
- **R2** `PUT /api/dictation/settings` with `{ cleanup: 'fast' | 'careful' | 'off' }` saves the
  member's choice; anything else is refused. A member who never chose gets `fast`.
- **R3** A member's choice applies to every dictation of theirs (upload, stream, the web's own
  dictation): Careful cleans with the careful model, Off returns the transcript as heard. A
  request asking for `literal` stays literal whatever the choice.
- **R4** The choice lives in the dictation store beside the word lists (member state that
  can't be rebuilt from Git), and survives a restart.
- **R5** The Dictate page shows the models line and the three cleanup choices; a choice is
  saved at once and says so.
- **R6** The live demo answers both routes with sample data.

Slice 2 (Mac app):

- **R7** Speech choice **Online** / **On this Mac only** on the same page; the server stores it.
- **R8a** While a member is on "On this Mac only", the server refuses audio from their Macs
  (`/transcribe` 403, the stream 4403), so a Mac app from before the choice can't send it. The
  browser's own dictation is not refused. A Mac refused this way asks for the choice and writes
  the dictation up itself.
- **R8b** `POST /api/dictation/clean` tidies text a Mac heard itself, with the member's choice
  and words; a device token may call it.
- **R8** The Mac app reads the choice and, with "On this Mac only", always writes the dictation
  up on the Mac, then sends only the text for cleanup unless Cleanup is Off.
- **R9** The Mac app's description of its Clean up / Literal mode says the member's web choice
  applies too (Off returns the words as heard even in Clean up).

## Out of scope

Other speech providers (each needs its own key and adapter), and an admin lock on the choice.
