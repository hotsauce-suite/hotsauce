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
