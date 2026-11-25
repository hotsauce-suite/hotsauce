# Plan: Dictate punctuation and "also heard as" spellings

## Status

- 2026-11-25: built and reviewed (PR #242). Every requirement has a test; Swift tests run in CI only.
  Shares `apps/server/src/dictation/store.ts` with PR #241 (send key and sounds); its migration
  goes after this one.

## Why

A teammate's dictations come back with thin punctuation. Short dictations (up to 40 words, no
fillers or corrections) skip the AI cleanup and paste the speech model's own punctuation, which
leans on pauses, so steady speakers get run-on sentences. Text the Mac heard itself (Apple's
recognizer) is weaker still and skipped the same way.

Word lists only spelled a word that was heard; there was no way to say "when you hear Rajeev,
write Rajiv", and short dictations never reached the AI that might have done it.

## Requirements

Punctuation

- **P1** A short English dictation goes to the cleanup when its punctuation looks thin: 8 or
  more words with no full stop, question or exclamation mark anywhere, or a run of 25 or more
  words with no punctuation at all.
- **P2** A short dictation that is already punctuated still skips the cleanup (stays instant).
- **P3** Text the Mac heard itself (`/api/dictation/clean`) goes to the cleanup whenever it is
  more than 3 words.

Also heard as

- **H1** Each word in My words and Team words can carry up to 10 "also heard as" spellings,
  saved per list (`PUT /api/dictation/words/heard-as`). `GET /api/dictation/words` returns them
  as `heardAs: { mine: {word: [..]}, team: {word: [..]} }` plus a flat `fixes` list
  (`[{heard, write}]`, the member's first). Old Mac apps ignore both.
- **H2** Removing a word removes its heard-as spellings. A spelling equal to its own word is
  dropped; one spelling can belong to only one word in a list.
- **H3** Every dictation's final text (upload, stream, Mac text; cleaned or not; clean or literal
  mode) has each heard-as spelling replaced by its word: whole words only, ignoring capitals,
  written exactly as the word is typed. "rajeev's" becomes "Rajiv's". Longer spellings win.
- **H4** The cleanup prompt names each heard-as spelling next to its word as a hint.
- **H5** The web Dictate page shows heard-as spellings under each word and lets the member add
  and remove them. The Mac app shows the same page.
- **H6** The Mac app keeps the last `fixes` list it fetched and applies it to text it pastes
  without the server (offline, or "On this Mac only" without tidy-up).

## Slices

1. Server: P1-P3 in `skipsCleanup`, fast-check property tests.
2. Server: H1-H4 store, routes, `applyFixes`, tests.
3. Web: H5, demo mocks, help text.
4. Mac: H6 in DictateCore with Swift tests.
