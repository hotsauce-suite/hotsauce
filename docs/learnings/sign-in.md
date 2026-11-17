# Sign-in and member ids

- Clerk user ids are per application. Moving from a development instance to production gives every person a new id. Never key new data by an id you don't own without a way to re-link it.
- A dozen stores and each browser's offline drafts were keyed by the Clerk id. Rewriting them all was the first plan; one alias record in front of `Principal.userId` replaced it and needs no migration, no downtime and no rollback step. Look for the one place an id enters the system before planning to rewrite everywhere it went.
- "This user doesn't exist" from the sign-in provider meant "revoke their devices". After a move that is true of everyone for a while. Keep "gone" and "not here yet" apart: refuse with a retryable error for the second.
- The record must exist before the move. Ship it, let it start once on the old instance, and read the `sign-in: N members on record` log line before changing keys.
- Many stores already keep the member's email beside the id (clips, devices, usage, briefings). That is a fallback map if a record is ever lost.
- `fast-check` is not installed in this repository; a small seeded loop gives the same kind of test without touching `package.json`.
- Matching people by email is an account-takeover surface. The review found three ways in: an address a member left, an unverified first account, and a deleted account made again (which would have revived its old tokens). Match only verified addresses, move every link on a change of address, and never match inside the same instance.
- Naming the instance by a hash of the secret key means a rotated key looks like a new instance. Heal the link when the same account id is seen again.
- The quickest proof after a real move is a credential made before it: a connected AI tool that still lists the member's own clips as theirs shows the id carried over, with no server access needed.
- Reading the server's data over SSH to cross-check ids can be refused by the operator's own safety rules. Put the check in the product's log line instead, so a move never depends on shell access.
