# Chat rooms as context (Ember, Campfire)

- Campfire-style chats give each bot a per-room address that ends in `/slack` for posting. The
  same path with `/messages` reads the room with the same key, so a room already saved for posting
  needs no new secret to be read. Slack's own incoming webhooks can only post.
- The bot API pages backwards (`?before=`, newest 40, oldest first) and forwards (`?after=`), with
  the next cursor in a `Link` header. Take only the cursor from that header, never its host, or a
  hostile chat could point the reader (and its key) anywhere.
- An unknown cursor is a 404, the same as a bad key. Treat a 404 with a cursor as "that message
  is gone" and recover (read back from the newest until a page meets the copy); a 404 without one
  means the bot was removed. Starting over from the newest page alone silently skipped everything
  between the deleted message and the newest page.
- A long first copy must save where it stopped (`backfill_before`): capping pages per pass without
  a saved cursor re-read the same newest pages forever on a big room.
- Save the room's progress before reading threads, and catch each thread on its own: one broken
  thread otherwise threw away a whole pass.
- Check the host's addresses on every pass, not only when the room is added: DNS can change.
- Matching a member in chat by first name catches words ("Will", "Mark", "May"). Count a first
  name alone only when it's capitalized or an @mention.
- The reviewer subagent found eight real bugs in a feature whose tests were all green. Write the
  failure paths (deleted message, refused bot, long history, private address) as tests up front.

## Claude in chat (2026-11-25)

- A Campfire-style bot delivery already carries where to answer: `room.path` is the bot's room
  address with its key, and with `?thread=<id>` when the mention was in a thread. Ember's webhook
  timeout is 30 seconds (not Campfire's 7), so the relay can read the thread and start the routine
  before answering. Read the room address only against the chat origin in settings, and check the
  resolved pathname: `new URL()` happily resolves `..` and `%2e%2e` segments.
- Claude Code routines fire over HTTP with a per-routine token and `{ text }` (max 65,536 chars);
  the text arrives wrapped as untrusted data, and there's no idempotency key, so never retry a fire.
  A fake token returns 401 from the real endpoint, which is a cheap live check that the call shape
  is right.
- Keep the bot's key out of the routine entirely: hand it an unguessable wake id that only a
  Hotsauce MCP tool can turn into a post. That also means the routine needs no network allowlist,
  since connector traffic goes through Anthropic.
- Team-only MCP connections drop every tool not marked read-only, so a "safe" write like
  `reply_in_chat` needs its own allow-list (`TEAM_SAFE_WRITES`) or the recommended locked-down
  setup silently can't answer.
- Limits checked before an `await` and recorded after it don't hold under concurrent requests:
  record the wake (or reserve the reply slot) in the same synchronous step as the check.
- A full `pnpm test` started before an edit can report failures for tests that pass afterwards;
  re-run just the failing files before believing it.
