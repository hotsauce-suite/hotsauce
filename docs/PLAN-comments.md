# Plan: comments, @mentions and For you

A conversation under an item, @mentions that notify, and one list of everything waiting on you.
Picked on 2026-11-13 from the "ideas to borrow from Basecamp" research. Charted as a map first
(issue "Map: comments, @mentions and For you", #109): sixteen decisions over two rounds, all answered
by the owner on 2026-11-15. This file is where that map ends: the spec the build threads work from.

## Status

- 2026-11-15: planned. Nothing is built. Each slice below is one thread and one release; a thread
  claims a slice by opening its draft PR and adding a line here.
- Slice 1 (requirements 1 to 11): being built, 2026-11-16, in the PR "Comments and @mentions on docs,
  meeting notes and tasks" (branch `claude/project-thread-9omzow`).
- Slice 2: not started.
- Slice 3: not started.
- Slice 4: not started.
- Slice 5: not started.

## Destination

A member asks for a teammate's attention on the item itself, the teammate is told once, and
everything waiting on them sits in one list they can clear.

## Decisions (the owner's, 2026-11-15)

1. **First items:** docs, meeting notes and tasks. Files, notes, links, boards and clips get the
   same comment box later, one small release each (slice 5).
2. **Shape:** one conversation at the bottom of the item. In a doc, a selected passage can be
   quoted into a comment. No comments anchored in the margin.
3. **For you collects:** @mentions, replies in a conversation you are in, and tasks someone else
   assigns you. Check-in questions and reminders stay where they are.
4. **For you lives** on a Today tile and on the rail with a count, pinned for every member by default.
5. **Told by** push and the count. No email.
6. **Mentions:** members only. No whole-team mention.
7. **Agents:** MCP reads comments and the For you list, and writes a comment as the member, shown
   as "via Claude" (the client's name). The assistant can't be mentioned.
8. **Editing:** you edit your own comment (it shows "edited") and delete your own. Admins delete
   anyone's. A conversation has no "finished" state.
9. **In a conversation:** everyone who has commented or been mentioned there, plus a task's creator
   and assignee. Each conversation has "Stop following".
10. **Clearing:** only Done removes an item. Opening the item marks it seen, which lowers the count.
    A new reply brings a Done item back, at the top. An assigned task also leaves when it is completed.
11. **Later** (tomorrow or next Monday): the item is hidden, then reappears at the top at 9 AM in
    the member's own zone and counts again. No second push.
12. **Check-ins:** a reply under your answer lands in For you, and @mentions work in answers and
    replies. Check-ins looks the same.
13. **Search, Ask and Briefcast** read comments; Briefcast says what is waiting on you (slice 4).
14. **Mac app:** the dock icon shows the For you count. The Chrome extension doesn't change.
15. **Team items only.** Items in a personal space get no comment box.
16. **Order:** the five slices below.

Decided by standing rules rather than asked: a conversation follows its item through moves and
renames and goes when the item is deleted; a comment written offline is queued and sent on reconnect.

## Design

Starting points for the build threads. Change them if the code argues otherwise, and record why here.

- **One comment is one file**, team space only:
  `.hearth/comments/<item id>/<comment id>.md` (both ULIDs; `.hearth` is the saved folder name the
  rename kept). Frontmatter `id`, `item` (the item's `id`), `author`, `created`, `edited?`,
  `mentions` (lowercase member emails), `quote?` (the quoted passage, docs only), `via?`; the body
  is the comment in Markdown. A new comment is a new file, so two people commenting at once never
  conflict and an offline comment replays as a plain create. Edit patches the body and `edited`;
  delete removes the file (history keeps it).
- **Keyed to the item's `id`**, never its path, so moves and renames need no work. A doc or meeting
  note without an `id` gets one on its first comment (`ensureId`, a frontmatter patch; the body is
  never reformatted). Deleting an item deletes its comment folder in the same commit.
- **Only the Comments service writes `.hearth/comments/**`** (`writablePath` refuses it), like
  Check-ins and Forms. The index gets a `comment` kind; every read comes from the index.
- **Mentions are resolved on the server** from the text against the member list (owners of personal
  spaces in the registry, the same list Check-ins asks). The client's picker is a convenience; the
  stored `mentions` is what the server resolved. A name that isn't a member stays plain text.
- **For you is derived, not stored.** Items come from the index: comments mentioning me, later
  comments in conversations I'm in, open team tasks assigned to me by someone else, replies under
  my check-in answers. Only my own state is written: `.hearth/for-you.json` in my personal space,
  per item `{ seen, done, later, following }` as instants. An item shows when its latest activity
  is after `done` and `later` has passed. Parsing drops what it doesn't understand, like `today.json`.
- **Push** goes through the existing sender (`meetings.reminderStore`), one per mention or reply,
  never to the author, never twice for the same comment (an edit that adds a mention notifies only
  the newly named). The existing notifications switch covers it; a finer switch waits on the
  Settings reorganisation.
- **Budgets:** the For you read uses the index only (no Git reads, no model calls) and stays under
  200 ms on 5,000 indexed files, the bar Today holds. Loading an item must not wait on its comments.

## Requirements

Each maps to a test at a public boundary (API integration test, component test, or e2e for the
journeys marked ★). Integration tests run on both host adapters.

### Slice 1: comments and @mentions on docs, meeting notes and tasks

1. A member adds a comment under a team doc, meeting note or task; it shows with their name and
   time, oldest first, and is there after a reindex from an empty SQLite file. ★
2. An item in a personal space shows no comment box, and the API refuses a comment on it.
3. Two members commenting at the same moment both succeed, in order.
4. Typing `@` offers members by name; picking one stores them in `mentions`. Text naming a
   non-member is left as plain text.
5. A mentioned member gets one push naming the author and the item; opening it lands on the comment. ★
   The author is never pushed for their own comment.
6. In a doc, selecting a passage and choosing Comment starts a comment quoting it; the quote shows
   above the comment's text.
7. The author edits their comment (it shows "edited") and deletes it; another member can't; an
   admin can delete it. An edit that adds a mention pushes only the newly named member.
8. Moving or renaming the item keeps its conversation; deleting the item removes it.
9. A doc with no `id` gets one on its first comment, and the rest of the file is byte-for-byte unchanged.
10. A comment written offline is sent on reconnect, once (depends on offline step A; until that
    ships, the box says it needs a connection and keeps the draft).
11. The item's page renders before its comments load, and an item with 200 comments stays usable.

### Slice 2: the For you list

12. For you lists every comment that mentions me, newest first, each with the item, who and when.
13. It appears as a Today tile and as a rail entry with a count; a new member's rail has it pinned,
    and existing members get it added once without disturbing their other pins. ★
14. Opening an item marks it seen and lowers the count; it stays listed.
15. Done removes it; a new mention on the same item brings it back at the top.
16. Later (tomorrow, next Monday) hides it until 9 AM in my zone, then it returns at the top and
    counts again, with no push.
17. My state follows me across devices and survives a reindex; another member never sees it.
18. The read stays under 200 ms on 5,000 indexed files with no Git reads.

### Slice 3: replies, assigned tasks, check-ins, the dock count

19. A reply in a conversation I commented in or was mentioned in lands in For you and pushes me once.
20. A task's creator and assignee are in its conversation without having commented.
21. "Stop following" on a conversation ends replies reaching me; a new @mention still does, and
    follows me again.
22. A team task someone else assigns me lands in For you, and leaves when it is completed or
    reassigned. A task I assign myself doesn't.
23. A reply under my check-in answer lands in For you; @mentions in check-in answers and replies
    notify and list like any other. The Check-ins pages look the same.
24. The Mac app's dock icon shows the count and clears at zero; a notification click opens the item.

### Slice 4: Claude, search, Ask, Briefcast

25. MCP: `list_comments`, `add_comment` and `list_for_you` (final names in `docs/mcp.md`). A comment
    written through MCP shows "via <client>" and notifies like any other.
26. Search finds a comment by its text and opens the item at that comment; results honor
    `visibleSpaces`.
27. Ask can quote comments on items the member can read.
28. Briefcast and the Agent brief say how many things are waiting on the member and name the newest.

### Slice 5: the other items

29. Files, notes, links, boards and clips each get the same comment box, one release each, with
    requirements 1 to 8 holding for that kind.

## Not yet specified

- **Links highlights and notes** (Links roadmap): private notes on a saved page that can be shared.
  Sharing one should post it as a comment under the link. Settle when slice 5 reaches Links.
- **Notification choices:** a separate switch for comments, and where it sits. Waits on the
  Settings reorganisation.

## Out of scope

Comments anchored in the margin; email; mentioning the assistant; changes to team chat; commenters
without an account (including on read-only share links); suggested edits; live presence; reactions;
project pages and the activity feed.

## Shared files each slice touches

Tell the coordinator before starting, and check open PRs for the same files.

- Slice 1: index schema and `kindOf`, `writablePath`, the push sender, the doc, meeting-note and
  task detail views, `apps/web/src/mocks/`.
- Slice 2: the rail and its default pins, Today tiles, `packages/format` (the state file).
- Slice 3: Tasks service, Check-ins service, the Mac app (`apps/dictate-mac`).
- Slice 4: the MCP server and `docs/mcp.md`, search, the assistant, Briefcast.

## Support materials (every slice)

The landing page (app windows, feature lists, FAQ), the live demo's sample data, the help center
(a "Comments and For you" page from slice 1), `README.md`, `docs/mcp.md` (slice 4), the Mac app
(slice 3), screenshots, and the looping videos for any screen that changes.
