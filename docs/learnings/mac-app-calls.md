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
