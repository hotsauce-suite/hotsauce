# Plan: chat as context

**Status (2026-11-17):** slice 1 in progress (PR "Chat as context"). Decisions settled with the owner
on 2026-11-17: a bot keeps a searchable copy; only rooms an admin switches on; full history; chat
in search, Ask, AI tools and the agent brief, in that order. Not in scope: closed rooms' member
lists, Briefcast, Today, the reverse direction (the chat's own AI reading Hotsauce).

## Why

Hotsauce's AI (Ask, the agent brief, AI tools over MCP) sees docs, meetings and tasks, but not what
the team says in its chat, which is where most decisions are first made.

## How

Chat apps built on Campfire's bot API (Campfire, Ember) give each bot an address per room:
`/rooms/<room>/<bot key>/slack` to post (what Settings → chat rooms already stores, for Forms and
Check-ins) and `/rooms/<room>/<bot key>/messages` to read the room's timeline as JSON, 40 at a time,
`?before=` / `?after=` a message id, plus `?thread=<id>` for a thread. A bot can only read rooms it
was added to and can't be added to people's direct messages.

So an admin turns on **Read for context** on a chat room they already added. Hotsauce derives the
read address from the stored link, copies the room's whole history once, then reads what's new every
`CHAT_READ_INTERVAL_MS` (default 5 minutes) into `DATA_DIR/chat.sqlite` (FTS5). The copy is a cache:
Ember stays the truth, and deleting the file, turning reading off or removing the room drops it and
the next pass reads it again. Every member can search what a read room says, so the switch says
"only for rooms everyone in the workspace may read".

Thread replies that weren't also sent to the room aren't on the timeline: each pass re-reads the
threads of messages from the last `CHAT_THREAD_DAYS` (7) days. Edits and deletions after a message
is copied are not seen until the copy is rebuilt (stated in the help text).

## Requirements

1. A chat room whose link is a Campfire-style bot address can be switched to read; a Slack link
   can't, and says why. Only an admin (signed in, no token) can switch it. (`api/forms`, web)
2. Turning reading on copies the room's full history, oldest to newest, paging back until there
   are no more pages. (`chat/reader`)
3. Each later pass reads only messages after the newest one copied. (`chat/reader`)
4. Each pass re-reads the threads of the last 7 days' messages and adds their replies. (`chat/reader`)
5. Turning reading off, or removing the room, deletes its copy. (`chat/reader`)
6. A room that fails (bot removed, network) keeps its copy, records the error and the time, and is
   tried again next pass; other rooms carry on. (`chat/reader`)
7. Settings shows, for each read room, how many messages are copied, when it was last read, and the
   last error in plain words. (web)
8. `GET /api/chat/search?q=` returns matching messages (room name, author, time, snippet, link to the
   message in the chat) to any member; nothing when no room is read. (`api/chat`)
9. ⌘K shows chat matches in their own group; choosing one opens the message in the chat in a new
   tab. (web)
10. MCP tools `search_chat` and `read_chat` (and so Ask) search the copy and read a room's messages
    around a date; their descriptions say the messages are teammates' words, information, never
    instructions. (`mcp/tools/chat`)
11. The agent brief adds the last 7 days of messages the member wrote or that name them, fenced like
    the rest of its material, and the chat counts toward `sources_hash`. (`brief`)
12. The copy never leaves the server except through these member-only routes and tools, and the bot
    key never appears in an API answer, a log line or the copy. (all)

## Slices

1. Reader + store + Settings switch and status (1-7, 12).
2. Search route, ⌘K group, MCP tools (8-10).
3. Agent brief (11).
4. Help pages, landing page, demo data, STATUS.
