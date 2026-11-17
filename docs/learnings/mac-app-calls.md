# Mac app: call detection

Learnings from "Take notes on this Zoom call?" (`DictateCore/CallWatch.swift`, `HotsauceDictate/CallDetector.swift`).

- **A call app's hold on the mic flickers while the call starts.** Zoom joining muted, a device
  switch, or Core Audio changing between two reads can drop the app for one 2 s tick. The first
  version went back to idle on any missed tick, so a flickering start could never reach its 4 s
  and the offer silently never came. Keep the time the app was first seen and give up only after
  a gap of more than 4 s.
- **Read Core Audio once per tick.** The probe and the decision each read the process list, so
  they could disagree (the probe showed Zoom as a candidate on the same line that said no call).
  Pass one snapshot to both.
- **Make every "no" explainable from the terminal.** A missed offer had four possible reasons
  (already recording, the 10-minute cooldown, a flicker, notifications refused) and nothing on
  the Mac said which. `status.callLastDecision` in the app's defaults now does, and
  `--call-probe` prints it. The app's defaults domain is `dev.hotsauce.dictate`; the old
  `com.havenbiosec.hearth-dictate` domain is stale and misleads.
- **A tolerance test must fail on the old code.** A test with one dropped tick that only checks
  "one offer eventually" passes on the old code too (it restarts and offers 4 s later). Check the
  offer comes on time, and add a mic that flickers every other tick.
- **"The call: Silent" doesn't mean no permission.** A process tap delivers only what the Mac
  plays, and a quiet Zoom room plays nothing, so a 3 s check failed on a working setup. Exact
  zeros can't tell "not allowed" from "nobody talking" either. The check now keeps listening in
  Mac mode and the message names the permission with a button to it.
- **TCC keys a self-signed app by its designated requirement** (`identifier … and certificate
  root = H"…"`), so rebuilds signed by the same local certificate keep their grants; a new bundle
  id (the rename) is a new app that has to be allowed again.
- **In zsh, `log` is a builtin.** `log show …` silently prints nothing; use `/usr/bin/log`.
- **Call-end auto-stop only knew the app's own recordings.** A meeting started from the call notice
  in mic-only mode never stopped. The page now tells the app it follows the call (`follow-call`).
- **Calendar reminder and call notice share one delegate.** `Reminders` is the
  `UNUserNotificationCenter` delegate for every notice, and `setNotificationCategories` replaces
  the whole set, so register all categories in one place. A notice with no category still opens its
  `path` on click; only a reminder's `join` key opens a call link, and only an http(s) one.
- **A test that starts a Mac-mode meeting must stop it before removing the fake bridge.** Deleting
  `window.hearthMac` in `finally` first left the live meeting running, which slowed unrelated test
  files in the same full run (the meeting note Enhance test failed 3 of 3 on CI, never alone).
  Bisect a "flake" that only shows up in the full suite by dropping the new tests and rerunning.
- **Auto-start must wait for the event's title.** The title state is set from the event in an
  effect, so an auto-start effect in the same commit still sees "Zoom call". Wait until the title
  matches the event (unless the member typed one), and key the form on the query so a second
  reminder opened on the same page starts fresh.
