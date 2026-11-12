# Plan: release images and the built-in updater

Status: slice 1 in progress (2026-11-12). Decided by Morgan on 2026-11-12: organizations,
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
