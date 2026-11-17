# Plan: download the Mac app from hotsauce.work, with one version number

## Status

- Slice 1 (download link with its version on hotsauce.work): built, in review.
- Slice 2 (build the Mac app with every Hotsauce release): waiting on the owner's answer and the
  signing key in GitHub secrets.

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
6. (Slice 2) A macOS GitHub runner builds, signs (the same self-signed identity, so permissions
   survive updates) and publishes `mac-app-<build>` after each Hotsauce release, so the newest
   download always carries the current release number.
