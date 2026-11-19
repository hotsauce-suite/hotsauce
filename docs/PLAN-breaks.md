# Plan: screen breaks

## Status

2026-11-19: plan written on the recommended answers to the owner's seven questions (asked in the
thread at 17:5xZ; building on the recommendations while the answers are pending). Nothing built yet.

## Decisions (recommended, pending the owner's yes)

- **Where it lives**: no rail item. A **Breaks** section on Settings → General, and a **Breaks** row
  next to Music in the account menu that turns breaks on and off and shows "Every 20 min".
- **Off** for everyone until they turn it on. Turned on, it starts at **every 20 minutes for 20
  seconds** (the 20-20-20 eye rule). Every: 5 to 120 minutes. Length: 10 seconds to 15 minutes.
- **The break**: a 10-second "Break in 10s" heads-up (Start now, 5 more minutes, Skip), then a
  gentle full-screen dim with a calming animation, a countdown and one line ("Look at something
  far away"). Three animations: **breathing circle** (default), drifting clouds, slow waves. Device
  set to reduce motion: a still, softly glowing circle instead.
- **Skip** and **5 more minutes** are always there. No strict mode.
- **Holds off** while a recording, dictation or screen share is open (like the music) and during a
  meeting on your calendar. Away from the computer for at least a break's length counts as the
  break: the timer starts over. On the Mac it also stops while the screen is locked or asleep.
- A soft **chime when the break ends**, on by default, can be turned off.
- Optional **working hours** (e.g. 9:00 to 18:00, Monday to Friday), off to start.
- Settings are the member's, kept in their personal space (`.hearth/breaks.json`, like the Today
  layout), so the Mac app and every browser share them.
- **One popup at a time**: browser tabs agree on one leader (BroadcastChannel); inside the Mac app
  the app owns the timer and the page shows nothing itself.

**The Mac app**: the page hands the settings to the app (`hotsauceBreaks` message handler). The app
keeps the timer, watches idle time and screen lock, and shows the break as a panel over every
display, above all apps, whether or not the Hotsauce window is open. It holds the break while it
dictates or records a call, and while the page reports a recording.

## Requirements

Each maps to a test, named in brackets when built.

- B1. Settings parse strictly: unknown or out-of-range values fall back to the defaults; the
  defaults are off, 20 minutes, 20 seconds, breathing, chime on, no working hours. [format breaks.test]
- B2. `GET /api/breaks` returns the member's settings (defaults when none saved); `PUT` validates,
  commits `.hearth/breaks.json` to their personal space, and saving the same settings is a no-op.
- B3. The schedule (pure logic): a break is due `every` minutes after the last break ended, the
  page loaded or breaks were turned on; Skip and a finished break restart the count; 5 more minutes
  moves it 5 minutes; changing `every` restarts the count. [breaks schedule property tests]
- B4. A break due while busy (recording, dictation, screen share, calendar meeting) waits until
  the busy state ends, then comes after a 1-minute grace.
- B5. Idle for at least the break's length counts as a break: the count restarts on return.
- B6. Outside working hours (when set) no break comes; the count restarts when hours begin.
- B7. The heads-up shows 10 seconds before; Start now begins the break; the break shows the
  chosen animation, a countdown, Skip and 5 more minutes; it ends itself and plays the chime when on.
  Esc skips. Reduced motion shows the still version.
- B8. Only one browser tab shows a break; closing the leader tab hands the timer to another.
- B9. Settings → General → Breaks: on/off, every, length, animation (with a live preview), chime,
  working hours, "Take a break now".
- B10. Account menu: a Breaks row next to Music; switching it on or off saves at once and its line
  reads "Every 20 min" or "Off".
- B11. Inside the Mac app the page shows no break itself; it posts the settings and its recording
  state to `hotsauceBreaks` on every change. The app parses them strictly.
- B12. The Mac app shows the break on every display above all apps, with the window closed; it
  holds while dictating or recording a call, stops while the screen is locked or the Mac sleeps,
  and counts idle time as a break.
- B13. The demo (demo.hotsauce.work) answers `/api/breaks`; help, README, STATUS and the landing
  page describe Breaks.
