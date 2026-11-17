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
