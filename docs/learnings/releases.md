# Releases and the built-in updater

Learnings from building release images and the self-updater (`docs/PLAN-releases-and-updates.md`).

- **A release is a version bump.** `release.yml` runs when `HOTSAUCE_VERSION` changes on main and
  does nothing for a version that's already tagged. Two PRs that both bump from the same version
  conflict on that one file; rebase and take the higher number.
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
