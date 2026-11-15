# Renaming the code from Hearth to Hotsauce

From the 0.15 scrub (2026-11-15) that took the old name out of the code, not just the screens.

- **A word-swap script needs a protect list, and the list is the hard part.** The swap itself is
  three regexes. What breaks things is the names that cross a boundary: data already written
  (`.hearth/`, `hearth:` links, commit trailers, feedback issue markers, a Google Calendar
  property, an IndexedDB name), installed clients on older versions (the Mac app's bridge
  handlers, URL schemes and autosave names; the Chrome extension's message sources) and settings
  on running servers (env var names). `scripts/rename-hearth.py` keeps that list.
- **The script ate its own compatibility code.** Lines that read both names, like
  `(Hotsauce|Hearth|HearthDictate)\.(dmg|zip)` or a second `startsWith('<!-- A Hearth …')`, became
  new-name-only, and their tests were renamed with them, so the suite stayed green. Before a rename,
  grep the old tree for lines that contain both the old and the new name, and protect them.
- **Prose about old names flips too.** "Connected an older version as `hearth`?" became `hotsauce`.
  Grep docs for "old", "older" or "still read" next to the new name after the run.
- **Uppercase and escaped spellings slip through.** `HEARTH://` (a case-insensitivity test) and
  `hearth\.example` inside a regex weren't covered by the lowercase protects.
- **Write the new name, read both.** The trailers (`Hotsauce-Via`, `Hotsauce-Label`,
  `Hotsauce-Conflict-Path`), the feedback markers and the committer env vars all follow that rule,
  with a test that reads the old spelling.
- **Keep the app links old until clients update themselves.** The Mac app has no self-updater, so
  `hearth://` and `hearth-dictate://` stay the links the web app emits.
- **An independent reviewer found five real misses** after the full suite was green. Budget for one.
