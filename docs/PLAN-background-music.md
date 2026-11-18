# Plan: light background music

## Status

2026-11-18: built in PR #194; every requirement has a passing test. Decisions settled with the owner on 2026-11-18 (he accepted every
recommendation and added "an option to turn it on in onboarding").

## Decisions

- A **music button** at the foot of the desktop rail (above Settings); on phones and tablets, a
  **Music** row in the Apps sheet. Tapping the button plays or pauses; a small panel beside it
  holds the track choice and a volume slider. Music keeps playing while you move between apps
  (the player lives outside the routes).
- Four calm instrumental tracks shipped with Hotsauce, every one **CC0** (public domain, so anyone
  may reuse and share them, no attribution required; we credit them anyway on the help page):
  Soft piano, Lo-fi, Ambient, Rain. They sit in `apps/web/public/music/` and load only when
  someone presses play; the offline cache never downloads them.
- **Off for everyone** to start. Each person's on/off, track and volume are remembered in that
  browser (like the light/dark choice). Browsers don't let a page start sound by itself, so after
  a reload with music on it starts again at the first click or key press.
- It **fades out while the page records** (meeting notes, Dictate, Ramble, Clips: anything that
  opens the microphone, camera or screen) and fades back when the recording ends.
- No organization switch: only the listener hears it.
- **Onboarding**: the Getting started tile on Today offers "Play calm music while you work?" with
  Turn on and No thanks, until it's answered in that browser. It is an extra line, not a counted
  step, so it never keeps the tile from finishing.

Not covered: the Mac app's own dictation and call recording happen outside the web page, so the
music doesn't pause for them (the Mac records the microphone, not the speakers; headphones avoid
any bleed).

## Requirements

Each maps to a test, named in brackets.

- M1. Off by default: no audio is created or fetched until the member presses play.
  [music/player.test]
- M2. Play and pause from the rail button; the panel changes track and volume; the choice, track
  and volume persist in this browser, and a bad stored value falls back to the defaults.
  [music/player.test, MusicButton.test]
- M3. After a reload with music on, it starts at the first click or key press, not before.
  [music/player.test]
- M4. While any microphone, camera or screen capture the page opened is live, the music is held
  (paused); it resumes when every captured track has ended, unless the member turned it off
  meanwhile. [music/player.test]
- M5. The Getting started tile offers Turn on / No thanks until answered here; Turn on starts the
  music, either answer removes the line, and the step count is unchanged. [StartTile.test]
- M6. On phones the Apps sheet has a Music row that opens the same controls. [MusicButton.test]
- M7. Every track file exists, is an MP3 and is credited (title, author, CC0, source link) on the
  help page. The offline cache never includes `music/`. [music/tracks.test]
- M8. The rail button, played and paused, in a real browser. [e2e music.spec]
