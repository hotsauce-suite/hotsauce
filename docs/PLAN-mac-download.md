# Plan: download the Mac app from hotsauce.work, with one version number

## Status

- Slice 1 (download link with its version on hotsauce.work): live (PR #167).
- Slice 2 (build the Mac app with every Hotsauce release, no update nags for number-only builds):
  live since 2026-11-17. The first GitHub build was mac-app-112 (0.36.1), and hotsauce.work showed
  it within minutes.

## Why

The Mac app took the Hotsauce release number only when someone built it by hand on a Mac, so it
fell behind (0.29.2 while Hotsauce was at 0.34.1), and the only link people shared was the first,
long-replaced `mac-app` release. People don't know the app and the suite are versioned apart.

## Requirements

1. `hotsauce.work/download/mac` redirects to `Hotsauce.dmg` on the newest `mac-app-<build>`
   release (highest build), found from the `mac-app-` tags alone, since the release list fills
   with Hotsauce releases. Test: `site/worker.test.js`.
2. `hotsauce.work/download/mac.json` returns `{ version, build, url, minimumMacOS }` for that
   build, from its `mac-app.json`; only a plain dotted version is passed through. Test: same.
3. GitHub is asked at most once per ten minutes per Cloudflare location (Cache API), and after a
   failure at most once a minute, so the unauthenticated API limit isn't reached. Test: same.
4. While GitHub can't be reached, the last good answer (kept a week) is used; with none, the
   download still works (the old `mac-app` release) and the version is `null`. A build whose
   version file is missing is still offered. Test: same.
5. The landing page shows "Download the Mac app · Version X · macOS 14 or later" under the hero
   buttons, filled in from requirement 2, and links to it from "Installs like an app"; the FAQ and
   the Mac app help page link to it. Checked in a real browser, desktop and phone, light and dark.
6. (Slice 2) After each Release run, a GitHub Mac builds main when its version or the
   `apps/dictate-mac` tree differs from the newest build, signs it with "Hotsauce Release Signing"
   from the repository's secrets, checks the signature and version, and publishes
   `mac-app-<build>` (the previous build plus one). Without the secrets it builds nothing.
   Checked by its first real run.
7. (Slice 2) `mac-app.json` carries `source` (the tree) and `sameAppSince` (the first build with
   that tree). An installed build at or above `sameAppSince` is current, in Settings
   (`apps/web/src/lib/macAppVersion.test.ts`) and in the app's own menu (`AppVersionTests.swift`).
9. The site deploy looks up the newest build with GitHub Actions' own token and passes it to the
   Worker (`MAC_APP_TAG`, `MAC_APP_VERSION`, `MAC_APP_BUILD`); the Worker asks GitHub itself only
   without them, because Cloudflare's unauthenticated calls were refused on the first live check.
   The Mac app workflow redeploys the site after each build. Test: `site/worker.test.js`.
8. (Slice 2) `scripts/build-app.sh` prefers "Hotsauce Release Signing" over the older
   one-Mac identity, so hand builds match GitHub's.
