# Plan: members keep their identity when sign-in ids change

## Status

Released in 0.34.1 (PR #164, 2026-11-17). Every requirement has a passing test (`apps/server/src/auth/identities.test.ts`). The independent review's findings are fixed (I10 to I12 came from it). Used the same day for a real move from a Clerk development instance to production: clips kept their owner and an AI tool connected before the move kept working. Not built: an admin screen that lists the record, and merging two members by hand.

## Why

Everything a member owns on the server is keyed by `Principal.userId`: clips, Ask conversations and usage, reading positions, calendar picks and cache, Dictate devices and word lists, access tokens, connected AI tools, briefing and podcast state, push subscriptions. Each browser also keys kept offline drafts by it. That id was Clerk's user id, and Clerk gives every person a new one when an organization moves to another Clerk application (development to production). A plain key swap would leave every member looking at an empty account.

## Decisions

- No store is rewritten. The member id becomes Hotsauce's own: the first Clerk id a person was seen with, kept for good. A small record links later Clerk ids to it by verified email.
- Email is already the identity under the domain lock (personal spaces are owned by email), so this adds no new trust. A new account takes over a member only when Clerk verified its email.
- The record is a JSON file on the data volume, in every backup. It is written rarely and read in memory.
- The instance is named by the start of a hash of its secret key, so nothing about the key or its host is stored.
- Going back to the old instance needs nothing: the old ids are still linked.
- A new id joins a member only when that member has no id in the same instance. An account deleted and made again in one instance starts fresh, exactly as before this change, so a departed person's tokens, connected apps and devices never come back.
- The record must exist before a move. Startup lists the accounts (retried on failure); an operator checks the log line before changing keys.

## Requirements

Each maps to a test in `identities.test.ts`, named by its number.

- I1: A member's id is the first sign-in id they were seen with and never changes.
- I2: A new sign-in id with the same verified email resolves to the same member, in any order of instances, including going back.
- I3: A new sign-in id whose email matches a member but is not verified is refused and linked to nothing.
- I4: The record survives a restart; an unreadable record stops the server rather than starting empty; nothing of the secret key is written.
- I5: At startup every existing allowed account is recorded, once per instance, and no account is removed. The log line gives the counts.
- I6: After a move, a member who signs in gets the same `userId`, and calls to Clerk (sign-in ticket, Google token) use the new Clerk id.
- I7: After a move and before the member signs in again, their access token and Dictate device are refused with `unauthorized` and not revoked; after one sign-in both work.
- I8: An account that already exists in the new instance is found by email without a sign-in.
- I9: An account deleted in the same instance is still reported gone.
- I10: After a verified change of address, every link of the member carries the new address; the old address matches nobody.
- I11: An account made again in the same instance is a new member; a later move follows the newest account.
- I12: A rotated secret key is the same instance once an account is seen or looked up again.
