# Plan: Send key, sounds, quieter audio and early warnings for Dictate

## Status

- Slice 1 (server + web: the member's send key and sounds, the web's dictation): in progress.
- Slice 2 (Mac app: send key, ⇧ to send, sounds, quiet other audio, warnings): in progress.

## Why

Ideas taken from Superwhisper's changelog (research page for Morgan, 2026-11-25). Superwhisper is
closed source: these are our own designs, nothing is copied. Morgan picked the Send key, quieting
other audio, the mic and connection warnings and sound themes, all at once, on the Mac and the web.

## Decisions (Morgan, 2026-11-25)

1. **Send key.** While dictating, pressing the send key (Space to start; the member can change it)
   ends the dictation, pastes the words and presses Return, so a chat message goes out. The mic
   stops after a send (Morgan changed this from "keep listening").
2. Return is pressed only when the app the dictation started in is still in front. Otherwise the
   words are copied and the overlay says so.
3. Holding ⇧ as a dictation finishes also sends it.
4. On the web, the send key ends the dictation and puts the words in the box without submitting.
5. **Sounds**: a short sound when dictation starts, stops, sends and is cancelled, in a few themes
   the member picks, or Off.
6. **Quiet other audio** (Mac): Off, Lower (to 30% of the volume) or Mute while dictating.
7. **Warnings**: say during the dictation when the mic hears nothing, and when the connection is
   slow, instead of failing after the member has finished talking.

## Design

- The send key and the sound theme are the member's, kept with their other Dictate choices on the
  server (`dictation_prefs`), so the web and every Mac follow one choice. They are picked in
  Dictate → Shortcut and sounds, and on Settings → This Mac. The Mac keeps the last known ones.
- Quiet other audio is a choice of each Mac (Settings → This Mac), like the dictation key.
- The sounds are synthesized from a small table of tones (no audio files): `apps/web/src/lib/
  dictateSounds.ts` and `DictateCore/DictateSounds.swift` hold the same table. A test checks the two
  name the same themes.

## Requirements

Server
- R1. `GET /api/dictation/settings` returns `sendKey` (`space`, `return`, `tab` or `off`; default
  `space`) and `sounds` (`soft`, `pop`, `click`, `chime` or `off`; default `soft`).
- R2. `PUT /api/dictation/settings` saves `sendKey` or `sounds` for the member; anything else is
  refused. A member's choice never changes another's.

Web
- R3. Dictate shows a "Shortcut and sounds" section with the send key and the sounds; each is saved
  as soon as it is picked, and each sound theme can be played.
- R4. Settings → This Mac shows the same two choices, and Quiet other audio.
- R5. While the web dictates, the send key (when focus isn't in a text field) stops it and adds
  the words, never submitting. Off does nothing.
- R6. The web plays the member's sounds on start, stop, send and cancel; Off is silent.
- R7. The web says "No sound from your microphone" when the first 2.5 seconds are silent, and
  "Slow connection, still writing it up…" when the words take longer than 4 seconds.

Mac
- R8. While dictating, the send key is swallowed and ends the dictation as a send; at other times
  it types as usual.
- R9. A send pastes and then presses Return, only in the app it started in; otherwise it copies.
- R10. Holding ⇧ as the dictation finishes sends it (not when the dictation key is Right ⇧).
- R11. The Mac plays the member's sounds on start, stop, send and cancel.
- R12. Quiet other audio lowers or mutes the Mac's output while dictating and puts it back after,
  unless the member changed the volume meanwhile; a volume left lowered by a crash is put back at
  the next launch.
- R13. The overlay says when the mic hears nothing for 2.5 seconds, and when the connection is
  slow (the stream isn't ready after 3 seconds, or the words take longer than 4 seconds).

## Not doing

- Keeping the mic on after a send (Morgan, decision 1).
- Pausing other apps' media: macOS has no public way to know what is playing, so a "pause" key press
  could start music instead.
