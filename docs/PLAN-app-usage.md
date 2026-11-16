# Plan: which apps get used (admin Usage page)

## Status

- 2026-11-16: building. Server report and the admin page in one PR. Wired into Settings →
  Organization after the Settings pages change (#106) lands.

## Why

An organization runs many apps. To decide which deserve polish and which could be hidden by
default, an admin needs to see which ones people actually use. Hotsauce already keeps a full
history of every change (Git), so the answer can be counted from that history, with no tracking
added.

## Requirements

- **U1.** `GET /api/admin/org/usage` answers admins only (403 for anyone else, and for access
  tokens).
- **U2.** For each app, for each of the last 12 weeks (Monday to Sunday, UTC, the current week
  last), it reports how many items were created, how many were created or changed, and how many
  different people did it.
- **U3.** It counts from Git history in every space: the team space and every personal space.
- **U4.** A file belongs to the app whose top folder holds it (`tasks/…` is Tasks), the same
  rule the web app uses to open a file; any other visible file is Docs. Briefcast episodes
  (`.hearth/briefcast/`) count for Briefcast. Hidden files otherwise (`.hearth/…`, `.trash/…`)
  count for nothing.
- **U5.** Changes Hotsauce makes itself (the committer's own address as author) are not counted
  as a person using an app.
- **U6.** An item changed several times in a week counts once that week. A moved or renamed
  file is a change, not a new item. A deletion counts for nothing.
- **U7.** Clips are counted from the clips list (created per week, by how many people), since
  their videos are not in Git.
- **U8.** Dictate keeps its history on each Mac and never uploads it. The report gives only how
  many Macs are connected and how many were used in the last 7 days.
- **U9.** The report never names a file, a title, a space or a person: only numbers.
- **U10.** The report is computed at most once every 10 minutes per server and served from
  memory meanwhile.
- **U11.** Settings → Organization has a Usage page for admins: one row per app with a small
  weekly bar chart, the totals for 12 weeks and the people in the last 4 weeks, busiest app
  first, apps with nothing at the bottom.
- **U12.** Today and Chat are listed with a line saying why they have nothing to count.

## Not in scope

- Hiding apps by default. That is a follow-up once the numbers are in.
- Any new tracking: page views, clicks, listening to a Briefcast.
