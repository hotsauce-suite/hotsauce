# Plan: Claude answers @mentions in chat

**Status (2026-11-25):** slices 1-3 built and reviewed on the "Claude in chat" PR. Decisions taken on the
owner's recommended answers (2026-11-25): a full Claude Code routine answers, not a quick model
call; the bot is named "Claude"; the routine gets only the Hotsauce connector and answers only;
team space only (its instructions say so, and the setup recommends a "Team space only, read only" connection, on which `reply_in_chat` is the one write allowed); rooms the bot is in and direct messages to it;
each mention is a fresh session given the thread; at most 20 wakes an hour.

## Why

People in the team chat want to ask Claude something where the conversation already is, and have
it look things up in Hotsauce, without opening another app.

## How

Chat apps built on Campfire's bot API (Campfire, Ember) POST a message to a bot's webhook when
someone mentions the bot or writes to it directly, and post whatever the webhook answers within
30 seconds as the bot's reply. The delivery says where to post later: `room.path`, the bot's room
address (`/rooms/<room>/<bot key>/messages`, with `?thread=<id>` for a reply in a thread).

Claude Code routines can be started over HTTP: `POST
https://api.anthropic.com/v1/claude_code/routines/<trig_…>/fire` with the routine's own bearer
token and `{ "text": … }` (at most 65,536 characters), answering the new session's address. A
routine is capped at 30 runs an hour.

So Hotsauce is the relay:

1. The chat bot's webhook is `https://<hotsauce>/api/webhooks/chat-claude/<secret>`.
2. On a delivery Hotsauce checks the secret, reads the thread (or the room's last messages) through
   the bot's address, records a **wake** (a random id, the place to answer, the time), fires the
   routine with the question, the context and the wake's id, and answers the webhook with a short
   "On it" so the person knows it was heard.
3. The routine's session looks things up with Hotsauce's MCP tools and posts its answer with the MCP
   tool `reply_in_chat(reply_id, text)`. Hotsauce posts it to the wake's address as Markdown.

The bot's key never leaves Hotsauce: the routine only ever sees the wake id, which can post to that
one place, a few times, for a few hours.

## Requirements

1. A delivery to `/api/webhooks/chat-claude/<secret>` with the wrong secret, or when Claude in chat
   isn't set up, is refused with 404 and starts nothing. (`api/chat`)
2. A good delivery fires the routine once, with the routine's token, the person's name, the room's
   name, their message and a reply id, and answers 200 `text/plain` "On it…". (`chat/claude`)
3. The text sent to the routine includes the thread's earlier messages when the mention is in a
   thread, or the room's last 15 messages otherwise, oldest first, and stays under 60,000
   characters. Reading them failing doesn't stop the wake. (`chat/claude`)
4. A routine that refuses (bad token, paused, rate limited, network) gets a plain answer in chat
   saying Claude couldn't start and why, records the error, and leaves no usable wake. (`chat/claude`)
5. More than 20 wakes in the last hour: the answer is "busy, try again in a bit" and nothing is
   fired. (`chat/claude`)
6. `reply_in_chat` with a live wake id posts the text to the wake's address as Markdown (in the
   same thread); a wake takes at most 3 replies and expires after 6 hours; an unknown or expired id
   is refused and posts nothing. (`chat/claude`, `mcp/tools/chat`)
7. A delivery whose `room.path` isn't a bot room address is refused; the place to answer is always
   the chat address in settings plus that path, never another host. (`chat/claude`)
8. An admin (signed in, not a token) can set the routine id and token, see the webhook address,
   make a new one (the old stops working), turn it off, and see the last wakes and errors. Members
   can't. The token never comes back, only its last four characters. (`api/chat`, web)
9. The bot key, the token and the webhook secret never appear in an API answer other than the
   admin's webhook address, a log line, or the text sent to the routine. (all)
10. `reply_in_chat` is only offered when Claude in chat is set up; its description says it only
    answers a chat wake. A team-only connection gets it too, and no other write. (`mcp/tools/chat`)
11. Mentions or replies arriving together can't pass the hourly or per-wake limits; a pasted long
    message is cut so the text still fits; a room path with `.`/`..` segments or escapes is refused.
    (`chat/claude`)

## Slices

1. `chat/claude` service and the webhook route (1-7, 9).
2. `reply_in_chat` MCP tool (6, 10).
3. Settings card, help page, STATUS, landing page, demo data (8).

## Not in scope

Waking on a reply without a mention (Ember doesn't deliver those), editing files or opening PRs
from chat, a separate Hotsauce account for Claude, the Mac app (chat is the same web page there).
