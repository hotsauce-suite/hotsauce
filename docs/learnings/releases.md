# Releases and the built-in updater

Learnings from building release images and the self-updater (`docs/PLAN-releases-and-updates.md`).

- **Releases number themselves (since 2026-11-16).** Until then every PR raised `HOTSAUCE_VERSION`
  and parallel threads kept claiming the same next number (0.14.2, 0.14.4 and 0.16.0 were each
  claimed twice in one day). Now no PR touches the file; `release.yml` runs after every merge,
  numbers from the newest *tag* (not the file, so a half-finished release is redone with the same
  number), writes the number to main as the workflow's own commit and tags last.
- **Writing to a protected main from a workflow needs a deploy key.** "Protect main" requires a
  pull request and six checks, and a PR opened with the workflow's token starts no checks, so a
  bot release PR would never merge. GitHub also refuses its own Actions app as a ruleset bypass
  actor (422 Validation Failed). A write deploy key, with "deploy keys" on the bypass list and the
  private key as an Actions secret, works. Its pushes do start workflows, so the release script
  ignores a change to HOTSAUCE_VERSION alone; that is what stops a release loop.
- **This cloud proxy can't write rulesets, deploy keys or Actions secrets**, and the auto-mode
  check refuses ruleset edits without the owner's written approval. Hand the owner one Terminal
  command for his Mac (gh is signed in there) and keep the private key on his machine.
- **Don't rebase a release commit and build a different commit.** Each run checks out main as it
  is, writes the number on top, and builds and tags exactly that commit. A merge that lands
  mid-run is either in it or starts the next run; nothing is built from one commit and tagged on
  another.
- **A waiting concurrency run is replaced, not queued.** With `cancel-in-progress: false` GitHub
  keeps one running and one pending run per group; a third cancels the second. That's safe only
  because every run releases main as it is when it starts.
- **Check a guard against the merge commit's first parent.** The "no version in pull requests"
  lint compares `HEAD^1..HEAD` of the PR's merge commit, so a number main gained after the branch
  started isn't blamed on the PR (a two-dot diff against main's tip would be).
- **Tag only after the image exists.** The workflow pushes the ghcr image first and creates the
  GitHub release last, so an instance never sees a release it can't pull.
- **A new ghcr package is private, even from a public repo.** Anonymous pulls (Fly, Docker, other
  organizations) get 403 until an org owner sets it public in the package's settings, which has no
  API. Check with an anonymous token: `curl "https://ghcr.io/token?scope=repository:<org>/<name>:pull"`.
- **The helper machine is what makes rollback safe.** An update run by the server itself dies with
  the machine it replaces. The helper runs on the *old* image (known to boot), so a release that
  can't start still gets rolled back.
- **Don't clear "updating" the moment the new version boots.** The first version did, and a review
  found the loop: new version boots and clears it, the helper still times out on the public
  address and rolls back, the old version sees nothing pending and starts the same update again.
  Keep `pending` until the helper's window has passed; a boot of the old version while pending is a
  rollback.
- **Fly's `/wait` gives up after 60 s**; the first pull of a new image can take longer. Retry it.
- **Count open meetings, not sockets**, when deciding whether an update would cut someone off: a
  laptop reconnecting has no socket for a moment, and anyone can hold an unauthenticated socket.
- **One generic image means no build-time settings.** The Chrome extension was the last one: the
  server now writes its own address into the zip it offers, and the store copy asks on first use.
  The Mac app can't be built on Linux at all, so it lives on the `mac-app` GitHub release (a
  prerelease, so `/releases/latest` never returns it) and servers fetch and cache it.
- **Old Mac apps break when an instance changes address.** The window treats a redirect to another
  host as leaving the app and shows a blank page. Changing the Server in the app's Settings fixes
  it; the shared app is set up from the server's Connect link instead of a built-in address.
- **Porting from a fork is a three-way merge** with the last ported commit as the base
  (`git merge-recursive <base> -- HEAD <fork>`), then a scrub and an independent review for
  leftover names, private file pointers and decision logs.
- **Don't treat "I started on the old version" as a rollback.** Haven's first real update (0.7.0
  to 0.8.1) worked, but the page said it had failed: settings were applied seconds after Update,
  the old version restarted before the helper had pulled its image, and the boot check called
  that a rollback. Only a boot on the old version *after* the new one ran is proof; otherwise
  wait out the helper's window. Read the Fly logs before believing the status line.
- **The Mac app's window must learn its server from the connection.** The shared app's built-in
  address is a placeholder, so a window that only reads Settings opens nothing on a fresh install.
  The server now reports its own address in `/api/health`, and the window follows a redirect to it,
  so an instance can change address without every member editing their app.
- **A window that shows an error page must retry on its own.** Self-updates restart the server for
  about five seconds several times a day, and the app opens at login before the network (or a VPN)
  is up; a "Try again" button alone reads to members as "the app takes forever to load".
- **`swift test` with only the Command Line Tools** can't find the Swift Testing macros; pass
  `-Xswiftc -plugin-path -Xswiftc /Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing`.
- **Unified logs hide URLs** (`<private>`), so a WebKit load timeline shows timings but not which
  page; launch with `log stream --predicate 'process == "Hotsauce" OR process BEGINSWITH "com.apple.WebKit"'`
  and read the `WebPageProxy::didCommit/didFinish` lines.
- **A quiet failed check costs a whole interval.** The updater asked GitHub every six hours and
  treated a failed ask (rate limit, timeout) exactly like "nothing new", with no log line, so Haven
  sat on 0.12.4 through three releases. Ask hourly, log the reason, retry ten minutes later, and
  show it in Settings.
- **GitHub's unauthenticated API limit is per address, and cloud hosts share addresses.** Sixty
  asks an hour across every app on a Fly egress IP runs out. `github.com/<repo>/releases/latest`
  redirects to the newest tag and isn't the API, so it makes a cheap fallback for the version
  (fetch with `redirect: 'manual'`; Node returns the real 302 with its `location`). Conditional
  (ETag) asks don't help here: a 304 is free only for authenticated requests.
- **A squash merge copies every commit message, and GitHub reads the skip-ci marker anywhere in
  it.** A feature commit that only *described* the marker (feedback screenshots are committed with
  it) carried it into the squash commit, so the push started no workflow and the release silently
  didn't happen. Keep the marker out of commit messages and PR titles (write "the skip-ci
  marker"). Since releases number themselves, a skipped run only delays the change to the next
  merge's release; run the Release workflow by hand on `main` if it can't wait.
- **"Release succeeded" no longer means "a release happened".** The Release workflow runs and
  succeeds after every merge, mostly releasing nothing, so anything chained on it with
  `workflow_run` (install-test.yml) must check that a release was created during that run.
- **Install by digest, and record it where the cheap path can read it.** A registry tag can be
  moved after a release, so the updater installs the digest each release recorded
  (`image-digest.txt`, attached in the same `gh release create` call, which keeps the release a
  draft until the file is up). Reading it from `releases/download/v<version>/…` sidesteps the
  API's per-address limit; that address always redirects to GitHub's file host, so don't fetch it
  with `redirect: 'manual'`. Anything the timer retries must not force a fresh API ask each tick:
  a release it can't install would otherwise cost six asks an hour.
- **A change to the updater only takes effect one release later.** Instances install the release
  that carries new updater code with the old updater; the first install that exercises it is the
  release after. Check that second release lands on Haven before calling an updater change done.
- **Release notes come from the pull request, not the commits.** Each PR's "## What's new"
  section (or None) is checked on the PR and collected by the Release workflow into
  `WHATS_NEW.json` in the "Release X.Y.Z" commit, so the server ships its own notes and the site
  reads them from `main`. Checklist lines (`- [x] tests pass`) look like bullets: the parser skips
  them. A hand edit to `WHATS_NEW.json` releases nothing, so it reaches Settings only with the next
  release.
- **Mac-only changes used to make no release (they do since 2026-11-24), so a version alone couldn't say a Mac app is behind.** The
  Mac app reports `version+build` and `mac-app.json` names both; the build breaks a tie. The
  server caches the DMG and `mac-app.json` separately, so a DMG older than the version file is
  fetched again, or Settings would offer an update and hand out the old app.
- **Swift tests on the owner's Mac use Swift Testing, not XCTest**: it has only the Command Line
  Tools, which don't ship XCTest.
- **Immutable releases mean one release per Mac build.** With GitHub's immutable releases on, a
  release's files can't be replaced or added to, so the single `mac-app` release that servers
  read could never take a new build. Each build is now its own prerelease, `mac-app-<build>`, and
  the server asks GitHub's API for the highest build (once per refresh, so the app, the zip and
  `mac-app.json` all come from the same one), falling back to the old `mac-app` release.
- **The Mac app's version only matched the release on the day it was built.** `build-app.sh`
  always read `HOTSAUCE_VERSION`, but builds were by hand on one Mac, so the app fell 15 releases
  behind in a day and people saw two numbers. Building on a GitHub Mac after every Release run
  fixes the number; `sameAppSince` in `mac-app.json` keeps those number-only builds from telling
  everyone to update (Hotsauce releases about ten times a day).
- **The first signing identity couldn't leave its Mac.** `create-signing-identity.sh` imported
  the key with `-x` (not exportable), so moving builds to GitHub needed a new identity, made once
  with the key sent straight to GitHub secrets and the keychain. Its first build costs members one
  more Accessibility grant. Make keys that CI will need exportable to CI from the start.
- **Don't find the newest Mac build from the release list.** Every Hotsauce release is a release
  too, so a `mac-app-<build>` falls off GitHub's first page of 100 within days. Ask for the tags
  alone: `git/matching-refs/tags/mac-app-`.
