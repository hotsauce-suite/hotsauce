# Mac app updates

Learnings from making the Mac app update itself (`docs/PLAN-mac-self-update.md`).

- **A Developer ID isn't needed to self-update safely.** Check the new copy with
  `SecStaticCodeCheckValidity` against the running app's own designated requirement. For the
  self-signed release identity that pins the certificate; an ad hoc build's requirement is its
  own hash, so it can never be replaced automatically (good: it fails closed).
- **`SecCodeCopyDesignatedRequirement` wants a `SecStaticCode`.** For the running app, go
  `SecCodeCopySelf` then `SecCodeCopyStaticCode` first; the macOS SDK rejects a `SecCode`.
  CI's `check` job compiles the Swift package on macOS, so this shows up in CI before the Mac.
- **Don't stage in `.itemReplacementDirectory`.** It lands in `/private/var/folders/.../T`, which
  macOS cleans; an update can wait there for days. Use the app's Caches folder, check it's on
  the same volume as the installed app (so the swap is a rename), and check the copy again
  right before swapping.
- **Moving the bundle aside needs the bundle itself writable**, not just `/Applications`. Check
  both, and remember a swap that reopened on the old version, or it offers the same update
  forever.
- **Pass paths to the swap helper as `sh -c script sh arg...` arguments**, never built into the
  script; it is testable on temp folders with a stand-in for `open`.
- **The old app (before 0.47) can't update itself**: anyone on it needs one last download and
  drag. Say so in help and the FAQ.
