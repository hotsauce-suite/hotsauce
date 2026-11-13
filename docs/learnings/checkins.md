# Learnings: Check-ins

- **A file is the best once-only flag.** The round summary's own file (`summary.md`) records that it was posted. It survives restarts and reindexes with no extra state, and a second writer loses on `unchanged: { blobOid: null }` instead of posting twice.
- **"Each person's own 9 AM" means rounds are per member, the summary per check-in.** Work out the member's round in their zone (`currentRound`), but time the summary's deadline in the zone of whoever set it up. Mixing the two was the first design's bug.
- **The registry's personal spaces are the member list.** There is no members table; everyone who has signed in owns a personal space, so `index.listSpaces()` with `ownerEmail` is who to ask.
- **Services in `services.ts` are built in order.** Briefcast and the Agent brief read Check-ins, and Check-ins needs the chat rooms, so the chat rooms and Check-ins moved above both.
- **`WEEKDAYS` already lives in `@hearth/format` (booking.ts).** Reuse it; a second export of the same name breaks the package's index.
- **Push test endpoints must look like a real push service** (`https://fcm.googleapis.com/…`); the subscribe route refuses anything else.
- **Web tests need new routes in `test/renderApp.tsx` too**, not just `router.tsx`; otherwise the page 404s in the test router and tests time out with no clear error.
- **`VoiceNotes.test.tsx` can throw "window is not defined" after teardown in a full local run** (untouched by this work; passes alone and in CI). Re-run it alone before chasing it.
