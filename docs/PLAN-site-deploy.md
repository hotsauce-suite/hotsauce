# Plan: GitHub publishes hotsauce.work

## Status

- 2026-11-16: workflow, live check and worker header built (this PR). Waiting on the two
  repository secrets before the first real deploy.

## Why

The site, its help pages and the live demo were deployed by hand with `wrangler deploy` from
Morgan's Mac. Merged changes sat unpublished until someone remembered, the Mac was often asleep,
and its safety check refused retries. GitHub now publishes them on merge.

## Requirements

- **R1** A push to `main` that changes `site/**`, `apps/web/**`, `packages/format/**` or the
  lockfile deploys the site and the demo. "Run workflow" on the Actions page deploys `main` by hand.
  (`.github/workflows/deploy-site.yml`)
- **R2** The deploy runs the site tests first and stops if they fail. One deploy runs at a time.
- **R3** Every response from both hosts names the deployed commit in `x-site-version`.
  (`site/worker.test.js`, "which version is live")
- **R4** After deploying, the run fails unless both hosts answer with this commit, and the live
  demo page matches the demo just built. (`site/verify-live.test.js`)
- **R5** Each page changed by the push (HTML, Markdown, text and the install script under
  `site/public/`) must match its built file live. (`site/verify-live.test.js`)
- **R6** The run fails with a plain message naming the secrets when they are missing.

## Setup (repository secrets, once)

- `SITE_CLOUDFLARE_API_TOKEN`: a Cloudflare API token from the "Edit Cloudflare Workers" template,
  limited to the account that owns hotsauce.work and to the hotsauce.work zone.
- `SITE_CLOUDFLARE_ACCOUNT_ID`: that account's ID.

These are separate from `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`, which the install test
uses on a throwaway test account.

## Out of scope

Release numbering and `release.yml` (another thread). Fly deploys of the app.
