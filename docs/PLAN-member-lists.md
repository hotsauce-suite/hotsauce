# Plan: back up stars, rail pins and recents

**Status:** built Nov 16, 2026; reaches instances with the next release. Every requirement below
has a passing test.

Each member's starred docs, pinned apps and recently opened docs lived only in `index.sqlite`.
That file is a cache: backups leave it out, the state mirror leaves it out (so on a Cloudflare
Container they were lost at every restart), and the documented fix for a broken index is to
delete it. An audit found this (docs/PLAN-audit-2.md, "Not fixed here"). They now live in their
own file, `DATA_DIR/account.sqlite`, which is backed up like Clips and Dictate.

## Requirements (each maps to a test)

1. Recents, stars and rail pins are kept per member in `DATA_DIR/account.sqlite`, survive a
   restart, and never lower the file's saved schema version (a rollback keeps a newer file).
   (`src/account/store.test.ts`)
2. A backup carries `account.sqlite`, and the state mirror keeps it; `index.sqlite` stays out of
   both. (`src/backup/backup.test.ts` "member lists" and "what goes in a backup";
   `src/state/mirror.test.ts`)
3. Deleting `index.sqlite` and starting again leaves every member's stars, pins and recents as
   they were, titles included once the space is indexed. (`test/integration/member-lists.test.ts`)
4. The first start of this release copies the lists an older release left in `index.sqlite` into
   `account.sqlite`, all or nothing, and only once: an unstar afterwards sticks through restarts.
   Rows already in `account.sqlite` win over the old copy (a later open, saved pins).
   (`src/account/store.test.ts` "copying from the index"; `test/integration/member-lists.test.ts`)
5. The API is unchanged: `GET/POST /api/recents`, `GET/POST /api/stars`, `GET/PUT /api/pins`
   return what they did, filtered to spaces the member can open. (`test/integration/api.test.ts`
   "recents and stars", "rail pins")

## Decisions taken

- **The old tables stay in `index.sqlite`, unused.** Dropping them would need an index
  migration, and a rollback to the previous release would then find its stars gone. A later
  release can drop them once no instance can roll back past this one.
- **Titles still come from the index**, looked up per row (at most 20 recents and a member's
  stars), so a renamed doc shows its new title and an unindexed one shows none, as before.
- **Copied once, marked in the new file.** Copying on every start would bring back what a member
  unstarred.

## Shared files touched

`apps/server/src/services.ts` and `api/env.ts` (one new store), `apps/server/src/index/db.ts`
(accessors moved out), `apps/server/src/main.ts` (closes it). No index migration.
