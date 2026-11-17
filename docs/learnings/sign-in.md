# Sign-in and member ids

- Clerk user ids are per application. Moving from a development instance to production gives every person a new id, and so does deleting and re-creating an account. Never key new data by an id you don't own without a way to re-link it.
- A dozen stores and each browser's offline drafts were keyed by the Clerk id. Rewriting them all was the first plan; one alias record in front of `Principal.userId` replaced it and needs no migration, no downtime and no rollback step. Look for the one place an id enters the system before planning to rewrite everywhere it went.
- "This user doesn't exist" from the sign-in provider meant "revoke their devices". After a move that is true of everyone for a while. Keep "gone" and "not here yet" apart: refuse with a retryable error for the second.
- The record must exist before the move. Ship it, let it start once on the old instance, and read the `sign-in: N members on record` log line before changing keys.
- Many stores already keep the member's email beside the id (clips, devices, usage, briefings). That is a fallback map if a record is ever lost.
- `fast-check` is not installed in this repository; a small seeded loop gives the same kind of test without touching `package.json`.
