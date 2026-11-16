# Second audit: features added since Nov 9, 2026

**Status:** fixes 1 to 3 merged (Nov 16, 2026); they reach instances with the next release. The
findings left for later are listed under "Not fixed here". Every requirement below has a passing test.

Two independent read-only reviewers, one for lost data and one for security, went through the
self-updater and rollback, saved page copies, the AI tool connector, public forms and booking
pages, and check-ins, and were asked for steps and then what is lost or exposed. Offline mode
and the connector's sign-in were read on their own branches; findings there went to those
branches' authors.

## Requirements (each maps to a test)

1. A read-only link is made only by Share. A save, a conflict resolve or the connector's
   `write_file` whose text carries a `share` the file doesn't have never opens the file at that
   link, and a file's real link keeps working through such a save.
   (`test/integration/shares.test.ts`, `test/integration/mcp.test.ts`)
2. After the updater puts the previous release back, that release starts on the databases the
   newer one migrated, keeps every row, and leaves the saved schema version alone, for the
   search index (which also holds stars, pins and recents), Clips and Dictate.
   (`src/index/schema.test.ts`, `src/clips/store.test.ts`, `src/dictation/store.test.ts`)
3. An AI tool can't replace a file it hasn't read: `write_file` on an existing file needs
   `base_blob_oid`, and a file too long to read whole comes back without one, so it can't be cut
   short by writing it back. (`test/integration/mcp.test.ts`)

## Not fixed here

- The page copy the Chrome extension sends is held in memory until its background read commits;
  a restart in between loses it and the retry fetches signed out. Keep it on disk until read.
- `save_link` through the connector fetches any public address, so a tool that was told to can
  send what it read out in the address. Don't fetch for connector saves until a member opens the link.
- The updater installs whatever image the release tag points at. Install by digest, taken from
  the release.
- Stars, pins and recents live only in `index.sqlite`, which backups leave out.
- After a rollback nothing checks that the previous release came up.
- Per-address limits on public forms and booking trust `fly-client-ip` on hosts other than Fly.
- State-changing requests don't check `Origin`; this rests on the sign-in cookie being same-site.
- Removing a form question hides its answers in the table and the CSV (they stay in Git); two
  pages of one hash-routed site count as the same saved link.
