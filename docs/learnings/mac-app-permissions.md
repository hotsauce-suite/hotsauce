# Mac app permissions

Learnings from checking the Mac app's permissions at every start (`docs/PLAN-mac-permissions.md`).

- **An ad-hoc signed build is a new app to macOS.** Each rebuild drops Microphone, Accessibility
  and Location grants, so a launch check right after an install will (correctly) open the setup
  window. Run `apps/dictate-mac/scripts/create-signing-identity.sh` once per build Mac so grants
  survive updates; `security find-identity -p codesigning` shows whether it exists.
- **One "awaiting" flag isn't enough once rows can turn green on their own.** macOS's notification
  prompt (asked at launch by Reminders) can be answered while the member is in System Settings for
  another row; bring the window back only for the row whose button sent them away.
- **`CLLocationManager.locationServicesEnabled()` can stall the main thread**; read it on a
  background queue. `authorizationStatus` from a delegate-less manager read at launch was accurate
  in practice (no false "missing" after a grant).
- **Checking a window from a Remote Control shell:** without Screen Recording, window titles and
  screenshots are unavailable, but `CGWindowListCopyWindowInfo(.optionAll)` still gives each
  window's size and whether it's on screen, enough to tell the 500-wide setup window is showing.
- **`status.missingAtLaunch`** (`defaults read dev.hotsauce.dictate status.missingAtLaunch`) is the
  quickest way to see what the launch check decided.
