# Plan: read-only links for people outside the organization

## Status

- 2026-11-17: decisions settled with the owner (below). Building in one PR.

## Why

Read-only links existed for docs, meeting notes, notes and pages (ARCHITECTURE §20), but one
organization switch made every link public at once, and Clips and Files had no outside link at
all. People want to send one clip or one doc to someone outside, deliberately, without making
every other link public.

## Decisions (2026-11-17)

1. Each link has its own audience: "People in <org>" or "Anyone with the link". The organization
   switch now only *allows* members to make "Anyone" links (and turning it off stops every one of
   them for signed-out people at once). Links made before this stay organization-only.
2. A clip's link shows the video with speed control, the title, the summary and the transcript.
   Not the AI notes, action items, comments or a download.
3. Files get the same choice; an outsider can view and download the file.
4. Links can expire: 7 days, 30 days (the default) or never.
5. Settings → Organization lists every link made since this change (what, audience, who made it,
   when it ends) with Turn off. Turning off counts at once.
6. No passwords.
7. Tables and whiteboards stay out for now.

## Design

- `LinkStore` (`DATA_DIR/links.sqlite`, backed up with the other SQLite files): one row per link
  token: kind (`doc|meeting|note|page|clip|file`), what it points at (space + path, clip id, or
  space + file id), `anyone`, `expires_at`, who made it and when, a title for the list. Git keeps
  the token in the file's frontmatter as before; the row holds the audience and the end date. No
  row means a link from before: organization-only, never ends. A lost row therefore fails safe.
- Turning a link off from Settings sets its end to now; the item's own Share menu then offers a
  fresh link (a new token).
- `/api/shared/:token` opens any kind. Signed out, it opens only an "Anyone" link that hasn't
  ended, while the organization switch is on; anything else signed out is 401 (so a guess learns
  nothing). An ended link is 410 for everyone.
- Clips: owner only may make or turn off a link. Files: anyone who can open the file's space.

## Requirements (each has a test)

- R1 A new link records audience and end date; the default end is 30 days.
- R2 Signed out: an "Anyone" link opens; an organization-only link, an unknown token, or any link
  while the switch is off is 401.
- R3 Signed in: any live link opens, whatever its audience.
- R4 An ended link (expired, or turned off from Settings) is 410 for everyone, and Share offers a
  fresh link with a new token.
- R5 "Anyone" can't be chosen while the switch is off (400), and the dialog says why.
- R6 A clip link shows title, summary, transcript (speaker names) and a playable video; never AI
  notes, action items or a download URL. Only the owner can make or turn off one. Deleting the
  clip ends the link.
- R7 A file link opens signed out when it is an "Anyone" link, with view and download URLs.
- R8 Settings lists links (admin only) and Turn off ends one at once.
- R9 MCP `share_link` takes `anyone` and `expires_days`; the default is organization-only, 30 days.
- R10 Links made before the change keep working for signed-in people and never end.
