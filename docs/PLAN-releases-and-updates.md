# Plan: release images and the built-in updater

Status (2026-11-12): slice 1 merged (PR #20, v0.2.0 is the first image); slices 2 and 3 built
(`apps/server/src/updates/`, Settings → Organization → Updates); slice 4 next. Decided by Morgan on 2026-11-12: organizations,
Haven included, run the published Hotsauce release with no code fork and no settings repo.
Settings live in Settings → Organization. Hotsauce updates itself on every release and rolls
back on its own when the new version fails its health check.

## Requirements

R1. Merging a change that raises `HOTSAUCE_VERSION` on `main` tags `v<version>`, publishes a
    GitHub release with notes, and pushes `ghcr.io/hotsauce-suite/hotsauce:<version>` and
    `:latest`. A version that is already tagged publishes nothing.
R2. The image holds nothing specific to one organization. Everything an instance needs is read
    when the server starts (env, or settings saved in the setup wizard).
R3. The Chrome extension zip offered at `/downloads/` talks to the server that served it,
    whatever address that server has, with no rebuild.
R4. The server knows its own version (`GET /api/health` reports it) and, at most every six
    hours, the newest published release.
R5. An admin sees "Version X is out" with the release notes in Settings → Organization, an
    Update button, and an automatic-updates switch.
R6. On Fly, with `FLY_API_TOKEN` set, Update starts a short-lived helper machine running the
    current (known-good) image. The helper moves the app's machines to the new image, waits for
    `/api/health` to pass, and moves them back to the old image if it doesn't within five
    minutes. The helper destroys itself when done.
R7. Elsewhere (Docker, Cloudflare), Update shows the steps for that host instead.
R8. After a rolled-back update the admin sees "Updating to X failed; still on Y" and automatic
    updates skip that version.
R9. Automatic updates wait while a meeting is being recorded (subject to Morgan's answer).

## Slices

1. Release workflow and a generic image (R1, R2, R3).
2. Version check and the admin notice (R4, R5, R7).
3. The Fly helper and rollback (R6, R8, R9).
4. Haven switches to the image; the old Haven repository is archived.

## How the Fly update works

- The server reads Fly's own variables (`FLY_APP_NAME`, `FLY_REGION`, `FLY_IMAGE_REF`) and the
  secret `FLY_API_TOKEN` (`fly tokens create deploy`, scoped to the app). Without the token,
  Settings shows the one command that adds it.
- Update writes `DATA_DIR/updates.json` (`pending`), then creates a machine with
  `auto_destroy`, no restarts, metadata `role=hotsauce-updater`, on the image it runs now
  (`FLY_IMAGE_REF`), running `node apps/server/dist/updates/helper-main.js`. The token reaches it
  as an app secret, never in the machine config.
- The helper (`updates/helper.ts`) updates each app machine's config to the new image (keeping
  services and mounts), waits for it to start, and polls `PUBLIC_URL/api/health` for
  `version` = the new one. After five minutes, or if Fly refuses, it puts the old image back.
- On boot, the server compares its version with `pending`. Only the helper restarts it during an
  update, so starting on the old version means a rollback: it records `failed` and adds the
  version to `skip`, which automatic updates honour. Starting on the new version keeps `pending`
  until the helper's window (12 minutes) has passed, since the helper can still roll back. A
  pending update that never replaced the machine counts as failed after 30 minutes.
- Update refuses when `PUBLIC_URL` is localhost (the helper checks through it), and a second
  click while one is starting. Fly's one-minute start wait is retried up to four times.
- Automatic updates run only on a single-machine app: each machine has its own volume and sees
  only its own meetings. With more machines an admin presses Update.
- An instance that also deploys from source (`deploy-fly.yml`, `scripts/deploy-fly.sh`) replaces
  the release image on every deploy; use one or the other.
- A rollback runs the old version on data the new one may have touched. Releases keep stored data
  readable by the previous release; a release that can't says so in its notes and in the PR.
- Automatic updates (on unless an admin turns them off) check GitHub every six hours and try
  every ten minutes, never while a meeting socket is open.
- Health is checked through the public address, so with several machines the check passes only
  once the address answers with the new version. Haven runs one machine.
