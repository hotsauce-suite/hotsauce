# Plan: the updater installs only the image each release recorded

Status (2026-11-16): both slices built in PR #120, on top of the auto-numbering release workflow
(PR #112). Decided by Morgan on 2026-11-16 (audit
follow-up, `docs/PLAN-audit-2.md` "Not fixed here"): install by digest, with no waiting period, so
releases still reach instances the same day.

## Why

The updater used to install `ghcr.io/hotsauce-suite/hotsauce:<version>`. A tag is a pointer that
can be moved in the registry after the release, by a re-run of the release job or by anyone who
can push packages, and every instance would then install whatever it points at. A digest names
exactly the bytes that were built and can't be moved.

What this does not cover: anyone who can edit the GitHub release can also replace the recorded
digest. GitHub's release immutability setting closes that (optional, a repository setting).

## Requirements (each maps to a test)

R1. The release job writes the digest of the image it just pushed (`sha256:<64 hex>`) to
    `image-digest.txt` and publishes it with the release, in the same step that creates the
    release, so no release is ever visible without it.
    (`apps/server/test/integration/release-workflow.test.ts`)
R2. The updater reads that file from the release's download address
    (`github.com/hotsauce-suite/hotsauce/releases/download/v<version>/image-digest.txt`, not the
    rate-limited API) and installs `ghcr.io/hotsauce-suite/hotsauce@<digest>`.
    (`src/updates/releases.test.ts`, `src/updates/service.test.ts`,
    `test/integration/updates.test.ts`)
R3. A release with no recorded digest, or with anything else in the file, installs nothing:
    no helper machine, no pending update, not counted as a failed update (so a fixed release can
    still go in), and Update shows why. (same tests)
R4. No waiting period: an instance installs a release as soon as it sees it, as before.

## Slices

1. Updater reads and installs the recorded digest (R2, R3, R4).
2. Release workflow records it (R1).

## Rollout

Instances on 0.17.1 and earlier install the first release with this change by tag, as before;
from then on every update goes by digest. Every release from that one on carries the file.
