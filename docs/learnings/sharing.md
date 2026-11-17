# Learnings: read-only links and sharing

General lessons from building outside links (docs/PLAN-outside-links.md, 2026-11-17).

- **`/api/links` was already taken.** Saved links (the Links app) own `/api/links`, and a new
  `GET /api/links` route silently shadowed them: dozens of Links tests failed with nothing
  pointing at the cause. Grep `apps/server/src/api/` for a route prefix before adding one; the
  sharing list lives at `/api/share-links`.
- **Keep audience and end date beside the token, not in Git.** The token in frontmatter is
  guarded everywhere a write passes (`assertOwnShare`); adding more share keys there would have
  meant guarding each of them too. A side table keyed by token (`links.sqlite`) needed no change
  to the guard, survives moves, and fails safe: a lost row is a members-only link.
- **A changed choice must replace the link, not be ignored.** The first cut returned the live
  link on any repeat "on", so an agent asking for `anyone: true` got the old members-only link
  back with no error. `wantsNewLink` decides; a plain repeat still keeps the link.
- **Read the organization switch once per request.** Checking it before the commit and again
  after let an admin's flip in between leave a committed token with no row.
- **Auto-made links must not expire.** Attaching a personal file to a team page and Files' Copy
  link both make links silently; with a 30-day default they would have broken a month later.
  They pass `{ anyone: false, expiresDays: 0 }` explicitly.
- **`new Date()` ignores a patched `Date.now`.** Tests that move the clock by replacing
  `Date.now` need the code to read `new Date(Date.now())`.
- **Signed media URLs outlive the link.** Clips and Files hand out presigned URLs valid for
  hours, so "off at once" holds for the page, not for bytes already loaded. Say so in help.
- **Outside views need their own shapes.** The signed-in file and clip views carry emails,
  AI notes and download URLs; build the public response field by field rather than trimming the
  internal one, and assert in a test that those strings never appear.

## A setting that changes meaning is dangerous until the release is live

The outside-links work kept the existing `publicShareLinks` switch but changed what it does (old:
every link opens signed out; new: members may choose "anyone" per link). The owner's steps page
went out before the release, the owner ticked the switch on the old version, and for a few minutes
every existing members-only link at that organization was public. Next time: when a change gives an
existing setting a new meaning, either use a new setting key, or hold any "go flip it" page until
the release is confirmed live, and say on the page what the switch does on older versions.
