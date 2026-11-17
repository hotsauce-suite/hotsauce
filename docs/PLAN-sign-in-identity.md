# Plan: members keep their identity when sign-in ids change

## Status

Built 2026-11-17 on branch `claude/project-thread-7g8dgw`. Every requirement has a passing test (`apps/server/src/auth/identities.test.ts`). Not built: an admin screen that lists the record, and merging two members by hand.

## Why

Everything a member owns on the server is keyed by `Principal.userId`: clips, Ask conversations and usage, reading positions, calendar picks and cache, Dictate devices and word lists, access tokens, connected AI tools, briefing and podcast state, push subscriptions. Each browser also keys kept offline drafts by it. That id was Clerk's user id, and Clerk gives every person a new one when an organization moves to another Clerk application (development to production) or an account is deleted and made again. A plain key swap would leave every member looking at an empty account.

## Decisions

- No store is rewritten. The member id becomes Hotsauce's own: the first Clerk id a person was seen with, kept for good. A small record links later Clerk ids to it by verified email.
- Email is already the identity under the domain lock (personal spaces are owned by email), so this adds no new trust. A new account takes over a member only when Clerk verified its email.
- The record is a JSON file on the data volume, in every backup. It is written rarely and read in memory.
- The instance is named by the start of a hash of its secret key, so nothing about the key or its host is stored.
- Going back to the old instance needs nothing: the old ids are still linked.

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
