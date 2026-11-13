# Plan: Backups, any S3 storage, Forgejo in the wizard, documents on the server

Status: built 2026-11-12/13 (backups, any S3 storage, Forgejo in the wizard, move to local). In
this order:

1. Automatic daily backups of the server's data volume to the organization's own storage, with a
   restore that has been tested.
2. Any S3-compatible storage for big files (video, kept audio, Files), not only Cloudflare R2.
3. Self-hosted Forgejo offered in the setup wizard.
4. Only after backups and a proven restore: move an organization's documents off GitHub onto the
   server's volume (`HOST_KIND=local`), then retire the old GitHub data org. `HOST_KIND=local` is the
   simplest default for new organizations.

Everything here is generic (no organization names in code) so it ports to public Hotsauce.

## Design

- **Object store client** (`apps/server/src/storage/s3.ts`): one S3 client over `aws4fetch` with a
  configurable endpoint, region and bucket, path-style URLs (`<endpoint>/<bucket>/<key>`), which R2,
  AWS S3, Backblaze B2, Wasabi, MinIO and Garage all accept. Put (streamed), get, delete, list by
  prefix, presigned GET. Cloudflare R2 is this client with endpoint
  `https://<account>.r2.cloudflarestorage.com` and region `auto`. The existing media store
  (`R2AudioStore`) becomes a thin use of it, so its behavior doesn't change.
- **Config**: `S3_ENDPOINT`, `S3_REGION` (default `auto`), `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
  `S3_SECRET_ACCESS_KEY`. The `R2_*` variables keep working and mean the same as the S3 ones with an
  R2 endpoint. `AUDIO_STORE=r2` keeps its name (pointer files written so far say `r2`); `s3` is an
  alias.
- **Backups** (`apps/server/src/backup/`):
  - *Snapshot*: a `.tar.gz` of `DATA_DIR`. SQLite databases are copied with SQLite's backup API
    into a staging folder first (never byte-copied mid-write); everything else is archived as is.
    Left out: what rebuilds or is temporary (`index.sqlite`, upload chunks, Clips work folders,
    live meeting `.pcm` audio, temp files, the state mirror's temp folder and old backups).
    Repositories (`repos/`, and `remotes/` for `HOST_KIND=local`) are included: once documents
    live on the server, they *are* the documents. Media kept on the volume (no object store) is
    included too.
  - *Upload*: written to a temp file on the volume, then streamed to
    `<BACKUP_PREFIX><instance>/<UTC timestamp>.tar.gz` (default prefix `backups/`), followed by a
    small `latest.json`.
  - *Schedule*: once a day after `BACKUP_HOUR` (UTC, default 3), checked every 15 minutes, and a
    few minutes after start if the last good backup is over 25 hours old. Last result in
    `DATA_DIR/backup/status.json`.
  - *Retention*: keep the newest 14 daily backups and the newest backup of each of the last 8
    weeks; older ones are deleted after each good backup. Never deletes when the new backup failed.
  - *On by default* whenever an object store is configured; `BACKUP=off` turns it off.
  - *Admins see it*: Settings → Organization shows the last backup (when, size, or the error) and a
    "Back up now" button.
- **Restore** (`pnpm --filter @hearth/server restore`, and `node dist/cli/restore.js` in the image):
  lists backups, downloads one (default: newest), checks it, and unpacks it into an empty
  `DATA_DIR` (or a target folder). Refuses a non-empty folder unless `--force`, which moves the old
  contents aside. The server then starts as usual; search rebuilds.
- **Forgejo in the wizard**: the "Files and audio" step offers repositories on this server
  (default), in a GitHub organization, or on a Forgejo server (URL, organization, token), checked
  with a test call before saving.
- **Moving an instance's documents from GitHub to the server** (`cli/move-to-local.ts`): mirrors
  each space's repository from the current host into the local host's bare repos, checks every
  branch's commit matches, then the instance is switched to `HOST_KIND=local`. The GitHub repos
  are left untouched until the switch is verified, so going back is just switching back.

## Requirements (each maps to a test)

- R1 The S3 client signs put/get/delete/list/presign against a configurable endpoint with
  path-style URLs; an R2 account id gives the R2 endpoint.
- R2 `S3_*` variables configure the media store; `R2_*` still do, with unchanged behavior.
- R3 A snapshot contains every durable file under `DATA_DIR`, SQLite databases as consistent
  copies (a row written in WAL mode is in the archive), and none of the excluded paths.
- R4 A backup uploads the archive and `latest.json` to the configured prefix and records status.
- R5 Retention keeps the newest 14 dailies and newest-per-week for 8 weeks, and deletes nothing
  after a failed backup.
- R6 The scheduler runs at most once per UTC day after `BACKUP_HOUR`, and soon after start when the
  last good backup is stale.
- R7 Restore into an empty folder reproduces the snapshot byte for byte (SQLite by content), and
  a server started on the restored folder serves the same documents and settings.
- R8 Restore refuses a non-empty folder without `--force`; with it, the old contents are kept aside.
- R9 Admins can read backup status and start a backup; members can't.
- R10 The wizard's storage step accepts any S3 endpoint and tests it before saving.
- R11 The wizard offers Forgejo (URL, org, token), tests it, and saves `HOST_KIND=forgejo`.
- R12 Moving documents copies every space's history from the old host to local repos and
  verifies every branch tip before switching.
- R13 A repository whose branches git has packed (`refs/heads` and `refs/tags` empty after a
  `git gc`) is backed up and restores to a repository git can read.
- R14 `/api/health/backup` is public and answers 503 when the newest backup failed or none has
  worked for 26 hours, 200 otherwise (also when backups are off or none has run yet), without
  the error text or times. A backup cut off by a restart isn't recorded as a failure.

## Drill (not a unit test)

Before step 4: take last night's real backup, restore it on a throwaway local server, and check
the documents, settings and recordings list against the live server. Result goes in Status below.

## Known limits

- Backups are not encrypted beyond the bucket's own encryption at rest. They hold sign-in
  tokens and saved keys, so the bucket must stay private.
- On AWS S3, set `S3_REGION` to the bucket's region (`auto` only works on R2 and some others).
- Adding a bucket to an instance whose media is on its disk sends *new* media to the bucket;
  media already on the disk isn't moved yet, and its pointer files name the old store.
- `LOCAL_HOST_DIR` outside `DATA_DIR` isn't backed up (the default is inside it).

## Status

- Built and reviewed. Independent review found git copies could be torn by a concurrent commit,
  a non-SQLite `.db` file failed every backup, shutdown waited on a backup, a 5 GB single-PUT
  limit, retry storms and a per-backup (not per-day) retention count; all fixed with tests
  (per-space git lock + fsck, header check, abort on close, multipart upload, 1-hour retry
  backoff, newest-per-day retention). Retention: 14 daily and 8 weekly.
- 2026-11-13: every backup on a busy instance failed with "not a git repository" once a `git gc`
  packed the team repository's branches: only files were staged, so the empty `refs/` folders
  were lost. The staged copy now gets git's folders back (R13), and `/api/health/backup` (R14)
  lets an uptime monitor alert on a failing backup instead of it failing quietly.
