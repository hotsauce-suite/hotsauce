# Second audit: features added since Nov 9, 2026

**Status:** fixes 1 to 3 are in pull request #115 (Nov 16, 2026) and reach instances with the
first release after it merges. The findings left for later are listed under "Not fixed here".

Two independent read-only reviewers, one for lost data and one for security, went through the
self-updater and rollback, saved page copies, the AI tool connector, public forms and booking
pages, and check-ins, and were asked for steps and then what is lost or exposed. Offline mode
and the connector's sign-in were read on their own branches; findings there went to those
branches' authors.

## Requirements (each maps to a test)

1. A read-only link is made only by Share. No other write opens a file at a link its sender
   chose: not a save, a conflict resolve, the connector's `write_file`, a header written on one
   line or through a YAML alias, two saves that merge into one, a file renamed into `.md`, or a
   `.md` uploaded as an asset. A file's real link keeps working through a save that tries.
   (`test/integration/shares.test.ts`, `test/integration/mcp.test.ts`)
2. After the updater puts the previous release back, that release starts on the databases the
   newer one migrated. Clips and Dictate keep every row and leave the saved schema version
   alone. The search index is made again for that release and keeps the spaces, stars, pins,
   recents and conflicts; every space is indexed again on start.
   (`src/index/schema.test.ts`, `test/integration/index.test.ts`, `src/clips/store.test.ts`,
   `src/dictation/store.test.ts`)
3. An AI tool can't replace a file it hasn't read: `write_file` on an existing file needs
   `base_blob_oid`, and a file too long to read whole (over 500,000 characters) can't be
   replaced by a tool at all, whatever version it names. (`test/integration/mcp.test.ts`)

## Not fixed here

- The page copy the Chrome extension sends is held in memory until its background read commits;
  a restart in between loses it and the retry fetches signed out. Keep it on disk until read.
- ~~`save_link` through the connector fetches any public address.~~ Fixed in 0.21.0 (#123): links an
  AI tool saves wait for a member to press Get the page (docs/PLAN-links-ai-saves.md).
- The updater installs whatever image the release tag points at. Install by digest, taken from
  the release.
- ~~Stars, pins and recents live only in `index.sqlite`, which backups leave out.~~ Fixed: they
  moved to `account.sqlite` (docs/PLAN-member-lists.md).
- After a rollback nothing checks that the previous release came up.
- Per-address limits on public forms and booking trust `fly-client-ip` on hosts other than Fly.
- State-changing requests don't check `Origin`; this rests on the sign-in cookie being same-site.
- A token holder can still replace a file without naming a version through the plain file API
  (`PUT /api/spaces/:space/file`); requirement 3 covers the connector's tool.
- Removing a form question hides its answers in the table and the CSV (they stay in Git); two
  pages of one hash-routed site count as the same saved link.
