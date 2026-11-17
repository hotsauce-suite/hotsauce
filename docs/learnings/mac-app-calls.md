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
