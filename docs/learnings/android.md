# The Android app and its widgets

Learnings from `docs/PLAN-android.md`.

- **No emulator in a cloud container.** There's no `/dev/kvm`, so nothing Android runs here. Put
  every decision a widget makes in plain Kotlin (`TodaySummary`, `ConnectNonce`, `QuickActions`)
  and unit-test that with JUnit and `org.json`; the Glance layouts are checked on a real phone.
  `./gradlew testDebugUnitTest lintDebug assembleDebug` is the whole local gate.
- **Maven Central rate-limits the container (429).** An init script that points Gradle at Google's
  mirror (`https://maven-central.storage-download.googleapis.com/maven2/`) gets past it; keep the
  script out of the repo and pass it with `--init-script`.
- **Glance only reads its inputs when a session starts.** Values read outside `provideContent`
  stay frozen while the widget's session is open (about 45 s after any tap), so `updateAll` after
  a refresh redraws the old data. Keep a stamp in the widget's Glance state, bump it with
  `updateAppWidgetState` before `update`, and read the stores inside `provideContent` under
  `remember(stamp)` (`Widgets.redraw`).
- **A phone token gets its own prefix and allow list.** `hpt_` tokens are checked before the
  Mac's `hdt_` ones in `api/middleware.ts`, and `useToken` filters by the stored kind, so the same
  secret with the other prefix is unknown. Widgets that only open the app (Quick capture, Voice
  note) need no token at all: they open the existing quick-action addresses in the signed-in
  Chrome shell, which kept the token at "read the summary, tick a task".
- **Don't treat every 401 as "disconnected".** An app newer than its server gets 401 for a route
  the old server's allow list doesn't have. Only the summary read decides that the phone was
  disconnected; a refused write just waits for the next refresh.
- **The connect callback is a custom-scheme link any page can fire.** A one-time nonce, compared
  in constant time and spent only on a match or expiry, stops a stray `hotsauce://connect` from
  planting a token or spoiling the real callback.
- **An agent can't make secrets on Morgan's Mac.** Its permission check refuses a script that
  runs `gh secret set`, even with his go-ahead. Give him the one Terminal command on a page
  instead, modelled on `apps/dictate-mac/scripts/create-release-signing.sh`, which never prints the
  key. The cloud proxy also refuses `/actions/secrets`, so a thread can't check which secrets exist.
- **Google Play only creates an app from a first upload by hand.** The workflow therefore puts each
  signed bundle on a GitHub prerelease (`android-app-<version code>`) as well, and only sends to
  Play once the service-account secret exists. `apps/android/scripts/play-upload.mjs` talks to the
  Play Developer API with Node's own crypto, so no third-party action ever sees that secret.
- **Today's e2e fails in the two minutes before UTC midnight.** The fake calendar seeds Acme sync
  1–2 minutes ahead, which lands it on the next UTC day. That's not a flake to re-run blindly;
  check the run's clock first.
