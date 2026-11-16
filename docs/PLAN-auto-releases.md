# Plan: releases number themselves

Status (2026-11-16): built in one slice (`scripts/next-release.mjs`, `.github/workflows/release.yml`,
the lint guard in `ci.yml`). Proof run: the first two app changes merged back to back after it
lands must come out as two releases with consecutive numbers.

Why: every pull request raised `HOTSAUCE_VERSION`, so parallel work kept claiming the same next
number and someone had to hand numbers out. Now nobody picks a number.

## Requirements

R1. No pull request changes `HOTSAUCE_VERSION`. The lint check fails a pull request that does,
    and doesn't blame a pull request for a number main gained after it started.
R2. After a merge to `main`, the Release workflow picks the next number from the newest `v*` tag
    behind main: a patch by default, a minor when any pull request since that tag has the
    `feature` label.
R3. A merge that only changes paths that never reach a running server (docs, top-level markdown,
    the site, CI, e2e, the tour video, the Mac app's sources) makes no release. The built Mac app
    (`apps/dictate-mac/release/`) goes into the image, so it does.
R4. The workflow writes the number to `main` as a `Release X.Y.Z` commit, builds and pushes the
    image from exactly that commit, and tags `v<version>` and publishes notes only after the image
    exists.
R5. One release runs at a time. A merge that lands while main is being written is retried; one
    that lands during the build starts the next release.
R6. A release that fails after writing its number is finished by the next run with the same
    number (the number comes from tags, not the file).
R7. The workflow's own version commit never starts another release.
R8. A hand-run from the Actions tab can force a release (even docs-only) and can make it a
    feature release.

## Tests

- R1: the guard step in `ci.yml`, proven on a real pull request.
- R2, R3, R6, R7: `apps/server/test/integration/next-release.test.ts` (real git repositories).
- R4, R5, R8: the proof run on GitHub (two merges back to back).

## Setup

- A deploy key with write access titled "Release robot", its private half in the Actions secret
  `RELEASE_DEPLOY_KEY`, and deploy keys on the "Protect main" ruleset's bypass list (Morgan ran
  one command on his Mac; the key never left it). GitHub refuses its own Actions app as a ruleset
  bypass actor (422), so the workflow token can't do it.
- To undo: delete the deploy key (GitHub → Settings → Deploy keys) and empty the bypass list.
- The `feature` label exists on the repository.
