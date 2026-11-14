# Architecture and build contract

This is the contract between the modules of Hearth and between the agents building them in parallel. If something here conflicts with a PRD, the PRD wins and this file gets fixed. If you need to change an interface in this file, change it here first, in the same commit as the code.

Phase 0 and 1 scope (see `PLAN.md`): platform spike + Docs-minimal. Meetings comes after and is not in this file yet beyond the file format.

## 1. Monorepo

```
hearth/
  package.json                pnpm workspaces; root scripts: dev, build, test, test:unit, test:integration, test:e2e, lint, typecheck
  pnpm-workspace.yaml         packages: apps/*, packages/*
  tsconfig.base.json          strict, ES2023, moduleResolution bundler, verbatimModuleSyntax
  biome.json                  lint + format (one tool; no eslint/prettier)
  vitest.workspace.ts         runs each package's vitest config
  playwright.config.ts        e2e; starts the server itself (webServer) in dev-auth mode
  e2e/                        Playwright specs + fixtures
  docker-compose.yml          forgejo (for integration tests and local dev of the Forgejo adapter)
  Dockerfile                  multi-stage: build web + server → node:22-slim with git installed
  deploy/fly.example.toml     one machine, one volume mounted at /data
  .github/workflows/ci.yml    lint, typecheck, unit, integration (with Forgejo service), e2e
  .env.local                  dev secrets (gitignored). Both apps read the repo root .env.local.
  apps/server/                @hearth/server  — Hono, git, SQLite, auth, sync, API, serves the SPA
  apps/web/                   @hearth/web     — React + Vite PWA
  apps/extension/             @hearth/extension — Chrome extension (MV3) for Meetings: capture a Meet tab without the share picker
  packages/format/            @hearth/format  — pure file-format library, no IO
  docs/                       PRDs, this file
```

Toolchain: Node 22 (`.node-version`), pnpm 10, TypeScript 5.x strict, Vitest, Playwright, Biome. Package manager commands always `pnpm`.

Conventions:

- ESM everywhere. `type: module`.
- Zod for every external boundary (env, API bodies, file frontmatter).
- No default exports except React route components and manifests.
- Errors: throw `HearthError(code, message, status)` from `apps/server/src/errors.ts`; the API layer maps it to JSON `{ error: { code, message } }`.
- Tests sit next to code as `*.test.ts` (unit) or under `test/integration/` and `e2e/`. Every module ships with tests; a PR without tests for new behavior is incomplete.
- Comments explain *why*, briefly. Match the surrounding density.

## 2. `@hearth/format` (pure, no IO)

The only code that knows how Hearth files look. Server, web, and scripts all import it. Keep it dependency-light: `yaml` (Document API, to preserve comments and key order), `ulid`, `zod`.

```ts
// ids
export function newId(): string                       // ULID, uppercase Crockford
export function isId(s: string): boolean

// frontmatter — preserves the original YAML text; never reorders or re-quotes untouched keys
export interface Parsed { data: Record<string, unknown>; yamlText: string | null; body: string }
export function parseFrontmatter(text: string): Parsed
export function patchFrontmatter(text: string, patch: Record<string, unknown | undefined>): string
//   - key: undefined deletes the key
//   - adds a frontmatter block if the file has none
//   - patch with no changes returns text byte-for-byte (tested)
export function ensureId(text: string): { text: string; id: string; added: boolean }

// titles, slugs, paths
export function slugify(title: string): string        // lowercase, a-z0-9-, trimmed, max 80
export function extractTitle(text: string): string | null   // frontmatter.title, else first H1, else null
export function docPath(folder: string, title: string): string // "docs/<folder>/<slug>.md", folder "" allowed
export function newDoc(title: string): { path: string; text: string }   // frontmatter {id,title,created} + "# Title\n\n"

// schemas
export const DocFrontmatter = z.object({ id, title?, created?, tags?: string[] }).passthrough()
export const MeetingFrontmatter = z.object({ id, type: 'meeting', title, date, duration_min?, attendees?, companies?, template?, calendar_event_id?, transcript?, ai_ranges?, models? }).passthrough()
export const SpaceConfig = z.object({ name: string, schema: 1 })      // .hearth/space.yaml

// space layout
export const SPACE_LAYOUT = { docs: 'docs', meetings: 'meetings', assets: 'assets', meta: '.hearth', trash: '.trash' } as const
export function initialSpaceFiles(name: string): Array<{ path: string; content: string }>  // README.md, .hearth/space.yaml, .hearth/docs/FORMAT.md, docs/.gitkeep, assets/.gitkeep

// links
export interface Link { href: string; text: string; from: number; to: number; kind: 'relative' | 'hearth' | 'external' }
export function extractLinks(markdown: string): Link[]
export function resolveRelative(fromPath: string, href: string): string      // normalized repo path
export function relativeLink(fromPath: string, toPath: string): string
export function rewriteLinksForMove(markdown: string, oldPath: string, newPath: string, folder?: { from: string; to: string }): string
//   fixes this file's own relative links; in a folder move, `folder` maps targets under `from` to `to`,
//   so links between files that moved together keep their bytes

// assets
export function assetPath(originalName: string, now: Date, id: string): string  // "assets/YYYY/MM/<slug>-<id8>.<ext>"

// meetings (format only; no behavior yet)
export function meetingPaths(date: Date, title: string): { note: string; transcript: string }
export function formatTranscriptLine(t: { at: number; speaker: string; text: string }): string  // "[hh:mm:ss] **Speaker:** text"
export function parseTranscript(text: string): Array<{ at: number; speaker: string; text: string }>

// search
export function chunkMarkdown(text: string, maxChars?: number): Array<{ heading: string | null; text: string; from: number; to: number }>
```

Tests: property-ish round-trip tests for `patchFrontmatter` over a corpus in `packages/format/test/corpus/*.md` (include Obsidian-style files, files with comments in YAML, CRLF, no trailing newline, no frontmatter). `extractLinks` against GFM edge cases (reference links, images, autolinks, code spans containing brackets).

## 3. `@hearth/server`

One Hono app, one process. `src/` modules, each with an `index.ts` barrel:

```
src/
  config.ts        zod env schema → Config
  errors.ts
  git/             GitStore
  hosts/           HostAdapter + local | forgejo | github
  index/           SQLite index, Indexer, search
  auth/            Authenticator + clerk | dev
  spaces/          SpaceService (membership, personal-space provisioning)
  sync/            webhook + poller + change broadcaster (WS); handshake.ts = first-message WS auth shared with meetings
  meetings/        Hearth Meetings: Transcriber, LLM, templates, sessions + audio WS, enhancer, chat, calendar (§7)
  api/             Hono routes; exports AppType for the web client
  cli/             `hearth reindex`, `hearth create-space`
  main.ts          wires everything; serves apps/web/dist with SPA fallback
```

### 3.1 Config (`config.ts`)

```
PORT=3000
PUBLIC_URL=http://localhost:3000
DATA_DIR=./.data                 # repos/, index.sqlite, uploads tmp
AUTH_MODE=clerk|dev                          # default clerk (fail closed); dev is only accepted when NODE_ENV is development or test
CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY      # when AUTH_MODE=clerk
ALLOWED_EMAIL_DOMAINS=acme.example        # comma list; enforced server-side in both modes
ALLOWED_EMAILS=                              # exact invited addresses outside those domains (optional)
HOST_KIND=local|forgejo|github
LOCAL_HOST_DIR=./.data/remotes               # local: bare repos as file:// remotes
FORGEJO_URL, FORGEJO_TOKEN, FORGEJO_ORG
GITHUB_TOKEN, GITHUB_ORG                     # token now; GitHub App credentials later behind the same adapter
HEARTH_COMMITTER_NAME="Hearth", HEARTH_COMMITTER_EMAIL="hearth@acme.example"
WEBHOOK_SECRET                               # production with a remote host: at least 32 characters, not the dev default
POLL_INTERVAL_MS=60000                       # tests set 1000
IDLE_COMMIT_MS=60000                         # how long the client waits before committing; exposed via /api/me
```

### 3.2 `GitStore` (`git/`)

Real `git` via `execFile`. Working clones at `DATA_DIR/repos/<space>`. One async mutex per space; every public method that writes runs under it.

```ts
export interface Author { name: string; email: string }
export interface Change { path: string; content: string | Uint8Array | null }   // null = delete; bytes for uploads
export interface Entry { path: string; type: 'file' | 'dir'; size?: number; oid?: string }
export interface Commit { oid: string; author: Author; date: string; message: string; label?: string }

export type CommitResult =
  | { status: 'committed'; oid: string; blobOid: string }
  | { status: 'merged';    oid: string; blobOid: string; content: string }   // three-way merge with concurrent change succeeded; client must adopt `content`
  | { status: 'conflict';  conflictRef: string; theirs: { blobOid: string; content: string }; ours: { content: string } }

export class GitStore {
  constructor(opts: { dataDir: string; committer: Author })
  ensureClone(space: string, remoteUrl: string): Promise<void>      // clone if missing; otherwise set-url
  remoteUrl(space: string): Promise<string | null>                  // an existing clone's origin URL (carries the credential; never log it), null without a clone
  headOid(space: string): Promise<string>
  readFile(space: string, path: string, ref?: string): Promise<{ content: string; blobOid: string }>
  readBlob(space: string, path: string, ref?: string): Promise<{ content: Buffer; blobOid: string }>   // undecoded bytes, for GET raw
  listTree(space: string, dir?: string): Promise<Entry[]>          // one level; dirs first
  listAll(space: string): Promise<Entry[]>                          // all files (for indexing)
  listClones(): Promise<string[]>                                   // spaces with a clone under DATA_DIR/repos
  changedPaths(space: string, from: string, to: string): Promise<string[]>   // paths that differ between two commits; not_found for an unknown commit
  commit(space: string, args: {
    changes: Change[]; author: Author; message: string;
    base?: { path: string; blobOid: string }                        // the version the client edited, for the single-file edit path
  }): Promise<CommitResult>
  move(space: string, from: string, to: string, author: Author,
       extraChanges?: (headOid: string) => Promise<Change[]>): Promise<{ oid: string }>
       // git mv + rewrite the moved file's own relative links. extraChanges runs under the space lock against
       // the commit the move is based on, and its changes land in the same commit (the API uses it to rewrite
       // links in other files that point into the moved path)
  moveAcrossSpaces(from: { space: string; path: string }, to: { space: string; path: string }, author: Author): Promise<{ removedOid: string; addedOid: string }>
       // copies the bytes, then removes the source; if the source changed after it was copied, it is
       // not removed (conflict, both copies kept)
  log(space: string, opts?: { path?: string; limit?: number }): Promise<Commit[]>                 // --follow when path given
  show(space: string, oid: string, path: string): Promise<string>
  diff(space: string, from: string, to: string, path: string): Promise<string>                   // unified diff
  sync(space: string): Promise<{ changed: boolean; headOid: string; paths: string[] }>            // fetch + fast-forward (or rebase unpushed), push if needed
  branchConflict(space: string, path: string, content: string, author: Author): Promise<string>  // commits `content` on refs/heads/conflicts/<ulid>; returns ref
  listConflicts(space: string): Promise<Array<{ ref: string; path: string; createdAt: string }>>
  resolveConflict(space: string, ref: string, resolved: { content: string }, author: Author): Promise<CommitResult>  // commit resolution on main, delete the ref
}
```

`commit()` algorithm, under the space lock:

1. `fetch origin main`. If local `main` is behind: fast-forward. If local has unpushed commits (an earlier push failed): `rebase origin/main`; on conflict, for each conflicting file, `branchConflict` with our version, take theirs, continue. If `main` was rewritten on the host (the new `origin/main` doesn't contain the one we had before fetching), the host wins: local resets to it, and only commits we never pushed (`<old origin/main>..HEAD`) are replayed with `rebase --onto`.
2. If `base` is given and HEAD's blob for `base.path` ≠ `base.blobOid` and HEAD content ≠ new content: `git merge-file -p <ours=new> <base> <theirs=HEAD>`. Clean → the merged text becomes the change, result is `merged`. Conflict → `branchConflict(ours)`, return `conflict` (nothing is committed on main).
3. Write changes into the work tree, `git add -A -- <paths>`, commit with `GIT_AUTHOR_*` = author and `GIT_COMMITTER_*` = Hearth. Empty diff → no commit, return `committed` with current HEAD.
4. `push origin main`. Rejected non-fast-forward → go to 1, at most 3 times, then throw `HearthError('push_failed')`.

Commit message convention: `<app>: <verb> "<title>"` with an optional trailer `Hearth-Label: <label>` for named versions.

Tests (`test/integration/git.test.ts`): use a temp dir with bare repos as `file://` remotes. Cover: clone, read/list, commit author vs committer, idle merge (`merged`), true conflict (`conflict` + ref exists + main untouched), outside push then our commit (fast-forward then commit), push race (simulate by pushing to the bare repo between fetch and push with a hook or by injecting a step), log --follow across move, moveAcrossSpaces, resolveConflict. These run without Docker or network.

### 3.3 `HostAdapter` (`hosts/`)

```ts
export interface HostAdapter {
  kind: 'local' | 'forgejo' | 'github'
  ensureRepo(name: string): Promise<{ cloneUrl: string }>          // idempotent; private
  deleteRepo(name: string): Promise<void>                           // tests only; guarded by NODE_ENV!=production
  ensureWebhook(name: string, url: string, secret: string): Promise<void>   // local: no-op
  parseWebhook(headers: Record<string, string>, rawBody: string, secret: string): { repo: string; ref: string } | null   // verifies signature
  addCollaborator(name: string, username: string): Promise<void>   // local: no-op
}
```

- A request that gets no response (DNS, refused, reset) is `host_error` like a failed one. Either way the detail (the cause, or up to 500 characters of the host's response body) goes to the server log; the error's message says only what failed and the status. GitStore does the same with git's output on fetch and push failures, which names server paths and remote URLs.
- `LocalHost`: bare repos under `LOCAL_HOST_DIR`, `file://` clone URLs. Used by unit/integration/e2e tests and by `pnpm dev` when nothing else is configured.
- `ForgejoHost`: REST API v1 with a token; org repos. Tested against `docker-compose` Forgejo (CI service container). Webhook signature is HMAC-SHA256 in `X-Forgejo-Signature`.
- `GitHubHost`: REST via `GITHUB_TOKEN` for now; the credential is a `() => Promise<string>` so a GitHub App installation token drops in later. Webhook: `X-Hub-Signature-256`. Tests run only when `GITHUB_TOKEN` and `GITHUB_TEST_ORG` are set.

The same integration suite (`test/integration/hosts.test.ts`) runs against every adapter available in the environment.

### 3.4 Index (`index/`)

SQLite via `better-sqlite3`, file `DATA_DIR/index.sqlite`, WAL mode, forward-only migrations (`schema_version`). `sqlite-vec` is loaded (smoke-tested) but unused until P1 embeddings.

```sql
files(rowid INTEGER PRIMARY KEY, space, path, id, kind, title, body, blob_oid, size, mtime, UNIQUE(space,path))
files_fts USING fts5(title, body, content='files', tokenize='porter unicode61')   -- external-content table kept in sync by triggers
sync_state(space PRIMARY KEY, head_oid, synced_at)
conflicts(space, ref, path, created_at, PRIMARY KEY(space, ref))
spaces(name PRIMARY KEY, kind CHECK(kind IN ('team','personal')), owner_email NULL, created_at)   -- personal spaces are bound to the owner's email, never to the derived handle alone
recents(user, space, path, opened_at, PRIMARY KEY(user,space,path))
stars(user, space, path, PRIMARY KEY(user,space,path))
```

Only `.md` files are indexed, and nothing under hidden folders (`.hearth/`, `.trash/`). `search()` returns `score` as negated bm25 (higher is better; title weighted 4x) and `snippet` with matches wrapped in `SNIPPET_OPEN` (`\u0002`) / `SNIPPET_CLOSE` (`\u0003`), which the web client splits on; snippets never carry HTML. Timestamps are ISO strings.

**The `spaces` table is a cache too.** Ownership is recorded in Git in each repo's `.hearth/space.yaml` (`kind`, `owner`); on startup and on `hearth reindex`, the table is rebuilt from the clones' `space.yaml` files, so deleting `index.sqlite` loses nothing. `hearth reindex` rebuilds `files` and `spaces`; it leaves `recents`, `stars`, `pins`, `conflicts` and `sync_state` alone.

```ts
export class Index {
  constructor(file: string)
  reindexSpace(space: string, files: Array<{ path: string; content: string; blobOid: string }>): void   // replaces the space's files in one transaction
  upsertFiles(space: string, files: ...): void
  removeFiles(space: string, paths: string[]): void
  search(q: string, opts: { spaces: string[]; limit?: number }): Array<{ space: string; path: string; title: string; snippet: string; score: number }>
  getSpace(name) / upsertSpace(...) / listSpaces()          // SpaceRegistry
  // recents/stars/sync_state/conflicts accessors; getFile; close
}
export class Indexer { constructor(git: GitReader, index: Index); full(space): Promise<void>; incremental(space, paths): Promise<void> }
// full() on a repo with no commits yet indexes the space as empty.
// GitReader = { listAll, readFile, headOid } — the slice of GitStore the indexer needs; readFile throws not_found for a missing path, which incremental() treats as a deletion.
```

### 3.5 Auth (`auth/`)

```ts
export interface Principal { userId: string; email: string; name: string; handle: string; isAdmin: boolean }
export interface Authenticator { authenticate(req: Request): Promise<Principal | null> }
```

- `ClerkAuth`: verifies the session token (`Authorization: Bearer` or Clerk cookie) with `@clerk/backend`, loads the user's primary email once per token (cached by `userId` for 5 minutes). Domain lock: email domain must be in `ALLOWED_EMAIL_DOMAINS`, or the primary address must be on the invite list `ALLOWED_EMAILS` (exact, and verified by Clerk), else delete the Clerk user and return 403 `domain_not_allowed`. Invited people sign in with Clerk's email code, and their handle carries their domain (`jo@gmail.com` → `jo-gmail-com`) so it can't take a member's personal space. They are full members: Team is theirs to read and edit. Authorized parties (the token's `azp`): `PUBLIC_URL`'s origin, plus `http://localhost:5173` (Vite) when `NODE_ENV=development`.
- `DevAuth` (only when `AUTH_MODE=dev`): header `x-hearth-dev-user: <email>`; same domain lock; name from the local part. Never enabled in production (`main.ts` refuses to start with `AUTH_MODE=dev` and `NODE_ENV=production`).
- `handle` = email local part lowercased, non `[a-z0-9-]` → `-`. Personal space repo name = handle. The handle is lossy (`a.b@` and `a-b@` collide), so it is only a name: ownership is recorded in the `spaces` table by email, `ensurePersonalSpace` refuses to provision a handle already owned by a different email (`forbidden`), and `canAccess` checks the recorded owner, never the handle string.
- Admins: `ADMIN_EMAILS` comma list in env.

### 3.6 Spaces (`spaces/`)

```ts
export interface Space { name: string; kind: 'team' | 'personal'; label: string }
export class SpaceService {
  ensureTeamSpace(): Promise<Space>                       // host.ensureRepo('team') + clone + initial files if empty
  ensurePersonalSpace(p: Principal): Promise<Space>       // repo = handle; called on first authenticated request
  visibleSpaces(p: Principal): Promise<Space[]>           // [team, personal]; personal only once provisioned in this process
  canAccess(p: Principal, space: string): boolean
}
// constructed with initialFiles: (name, { kind, owner? }) => initialSpaceFiles(name, { kind, owner }) from @hearth/format;
// owner is the member's email for a personal space, so ownership is written into .hearth/space.yaml.
// and webhook: { url: `${PUBLIC_URL}/api/webhooks/git`, secret: WEBHOOK_SECRET }: provisioning calls
// host.ensureWebhook after ensureRepo (idempotent; a failure is logged, and the poller covers it).
export function rebuildRegistryFromClones(git: { listClones, readFile }, registry: SpaceRegistry): Promise<void>
```

Claiming a personal space checks the owner recorded in Git too: after cloning, if the repo's `.hearth/space.yaml` names a different owner, the registry row is set to that owner and the claim is `forbidden`. A repo with no config, or one naming no owner, can be claimed.

Provisioning a space that is already cloned doesn't depend on the host: if `host.ensureRepo` fails, the failure is logged and the clone keeps its remote URL (`git.remoteUrl`), so the server boots and existing members keep working while the host is down; sync catches up once it is back. A space with no clone still needs the host.

`rebuildRegistryFromClones` runs at startup and in `hearth reindex`: it upserts the `spaces` table from each clone's `.hearth/space.yaml` (never deletes rows). `team` is always team. An older seed whose `space.yaml` has no `kind`/`owner` is logged and gets no row (a personal row needs an owner), keeping any row the table already had; with no row, nobody can open it until a member with that handle signs in and `ensurePersonalSpace` claims it. The API refuses to write, move or delete `.hearth/space.yaml` (403), since it is the ownership record.

### 3.7 Sync (`sync/`)

`Syncer` is the one path from "HEAD moved" to "the index and every client know":

- `syncSpace(space)`: `git.sync(space)` → `afterHeadChanged(space)` → reconcile conflict branches with the index's `conflicts` table, broadcasting `conflict` for new ones (a rebase during sync can create them).
- `afterHeadChanged(space)`: indexes everything in `git.changedPaths(lastSyncedHead, HEAD)` (`indexer.incremental`, which removes deleted paths; `indexer.full` when there is no recorded head or it is unknown), records HEAD in `sync_state`, and broadcasts `changed` with those paths. It works from the recorded sync point rather than from the paths one commit touched because `commit()` fast-forwards over outside pushes first; those files would otherwise never be indexed. Serialized per space. The API calls it after every commit it makes on main, and records `conflict` results (index + broadcast).
- `POST /api/webhooks/git`: `host.parseWebhook` → if the repo is a known space, `syncSpace` (awaited; failures logged) → 204. A `null` parse is 401: the adapters return null for a bad signature and for non-push events alike, so a non-push event (GitHub's `ping`) also gets 401. A request with neither `X-Hub-Signature-256` nor `X-Forgejo-Signature` is 401 before its body is read; a body over 5 MB is 413.
- `Poller` every `POLL_INTERVAL_MS` over `index.listSpaces()`, one space at a time; the next pass is scheduled when the last ends, so passes never overlap. A failing space is logged and skipped.
- `Broadcaster` over WebSocket `/ws` (`@hono/node-ws`). Browsers can't set headers on a WebSocket and tokens must not go in the URL (access logs), so auth is the first message: the client opens `/ws` with no query string and sends `{ type: 'auth', token }` (Clerk session JWT) or `{ type: 'auth', devUser: email }` (dev mode). The server answers `{ type: 'ready' }` or closes with code 4401 within 5 s; no events before `ready`. A client frame over 16 KiB closes the socket with 1009. Events: `{ type: 'changed', space, headOid, paths }` and `{ type: 'conflict', space, path, ref }`, filtered to spaces the principal can access (`spaces.canAccess`). A protocol-level ping goes out every 30 s; a client that didn't answer the previous one is dropped. The principal is fixed at the handshake (a Clerk JWT expiring later doesn't close the socket).

### 3.8 API (`api/`)

All under `/api`, JSON, authenticated except `/api/health` and `/api/webhooks/*`. Zod-validated with `@hono/zod-validator`. `createApp(deps)` in `src/app.ts` builds the API from injected services (`{ config, git, host, index, auth, spaces, syncer }`; the indexer and broadcaster reach it through `syncer`), and `src/index.ts` exports `type AppType = ReturnType<typeof createApp>` for the web's `hc<AppType>()` client. `main.ts` mounts it next to `/ws` and the SPA.

Every authenticated request runs `auth.authenticate(req)` and then `spaces.ensurePersonalSpace(principal)` (a no-op once provisioned). If that fails with `forbidden` (another member holds the handle), `host_error` or `push_failed`, the request carries on with team-only access (`/api/me` lists `[team]`), logged once per member. After authentication, request bodies over 12 MB are 413 (an anonymous request's body is never read). Errors are `{ error: { code, message } }` with the `HearthError`'s status; anything unexpected is a logged 500 with a generic message. Unknown `/api/*` paths are a JSON 404.

```
GET  /api/health                              → { ok: true, authMode: 'clerk' | 'dev' }
GET  /api/me                                  → { principal, spaces: Space[], settings: { idleCommitMs } }
GET  /api/spaces/:space/tree?dir=             → Entry[]
GET  /api/spaces/:space/file?path=&ref=       → { content, blobOid, headOid }      (404 when missing)
PUT  /api/spaces/:space/file                  { path, content, baseBlobOid?, message?, label? } → SaveResult (409 when status=conflict)
DELETE /api/spaces/:space/file                { path } → { oid }   (a file or a folder; moves it to .trash/<YYYY-MM-DD>/<path> in one commit; a second delete of that path that day goes to .trash/<YYYY-MM-DD>-<id8>/<path>, so names and a meeting's transcript stay together)
POST /api/spaces/:space/move                  { from, to } → { oid }   (also rewrites links into `from` in other docs, same commit)
POST /api/spaces/:space/share-to-team         { path, toFolder } → { teamPath }   (personal spaces only; teamPath = toFolder/<file name>)
POST /api/spaces/:space/folder                { path } → { oid }   (commits <path>/.gitkeep)
GET  /api/spaces/:space/history?path=&limit=  → Commit[]   (limit defaults to 100, max 1000; path optional)
GET  /api/spaces/:space/show?oid=&path=       → { content }
GET  /api/spaces/:space/diff?from=&to=&path=  → { diff }
POST /api/spaces/:space/restore               { oid, path } → SaveResult   (message `docs: restore "<title>" to <oid7>`; non-markdown files are restored byte for byte)
GET  /api/spaces/:space/conflicts             → [{ ref, path, createdAt }]
GET  /api/spaces/:space/conflict?ref=         → { path, ours: { content }, theirs: { content, blobOid } | null }   (theirs = main now)
POST /api/spaces/:space/conflict/resolve      { ref, content } → SaveResult (409 if the resolution conflicts again)
POST /api/spaces/:space/assets                multipart, field `file` → { path }   (≤10 MB, else 413 bad_request)
GET  /api/spaces/:space/raw?path=             → the file bytes
GET  /api/search?q=&spaces=&limit=            → [{ space, path, title, snippet, score }]   (spaces: comma list, default all visible)
GET  /api/recents                             → [{ space, path, title, openedAt }]
POST /api/recents                             { space, path } → { ok: true }
GET  /api/stars                               → [{ space, path, title }]
POST /api/stars                               { space, path, starred } → { ok: true }
POST /api/webhooks/git                        → 204, or 401 (see §3.7)
WS   /ws                                      (see §3.7)
```

- `SaveResult` is `CommitResult`, except that `committed` also carries `content` when Hearth changed what the client sent; the client adopts it as it adopts `merged` content.
- Saves of `.md` files run `ensureId` (every doc Hearth saves has an `id`); if the sent text has no `id` but the file at HEAD has one, that id is kept instead of minting a new one. Frontmatter that can't be patched in place is 400 `bad_request`. The commit message is `docs: create "<title>"` or `docs: edit "<title>"` (title from `extractTitle`, else the file name), or the client's `message`; `label` adds the `Hearth-Label:` trailer to either.
- `raw` sends `ETag: "<blobOid>"`, `Cache-Control: private, no-cache` (the URL names a path, whose bytes can change, so the browser revalidates each time; an unchanged file is a cheap 304), `nosniff`, and a sandboxing CSP, and answers `If-None-Match` with 304. Images, PDF and text are served inline by extension; anything else as `application/octet-stream` with `Content-Disposition: attachment`. In dev mode an `<img>` can't send the dev header, so the client fetches with it and uses a blob URL; with Clerk the session cookie authenticates it.
- Recents and stars are keyed by the member's email and filtered to spaces they can still access.

Authorization: every `/api/spaces/:space/*` route checks `spaces.canAccess` (403 `forbidden`). Personal spaces are visible only to their owner; there is no admin override for reading personal spaces. Search silently drops spaces the member can't access.

## 4. `@hearth/web`

React 19, Vite, React Router (data router), Tailwind v4 with tokens, `vite-plugin-pwa`, `@clerk/react` (Google only) or a dev sign-in form when the server reports `authMode: 'dev'` (`GET /api/health` includes `authMode`). API client: `hc<AppType>` from `@hearth/server` (type-only import) with the auth header injected.

Routes:

```
/                         → redirect to /docs
/docs                     → shell: sidebar (space switcher, tree, Recent, Starred) + empty state
/docs/:space/*            → editor for the file at the path
/sign-in                  → Clerk <SignIn/> with Google only, or the dev form
```

Components (each with a `*.test.tsx` where there's logic):

- The shell (`AppShell`), as built since 2026-11-10: an **app rail** (`AppRail`) on the far left, then the active app's sidebar (`SidebarFrame`: the app's name, the app's own body, the hearth glow), then the page. The rail draws the organization's mark, or by default the Hotsauce bottle (`ProductMark` in `Icon.tsx`, the same drawing as `public/favicon.svg` and hotsauce.work), the member's **pinned apps** (`src/apps/pins.ts`, PLAN-pinned-rail.md: up to six ids from `APPS` (`src/apps/registry.ts`) and the links that leave the suite, such as the chat link when `CHAT_URL` or the chat setting is set, which open in a new tab; saved per member by `GET/PUT /api/pins` in the index's `pins` table, which reindex keeps; defaults Today, Docs, Tasks, Meetings, Chat), each with its icon, short label, ember wash and `aria-current="page"` when active, and a dot on Meetings while a meeting is recording or paused. The open app, when it isn't pinned, shows below the pins. At the bottom: the grid button that opens the **launcher** (`Launcher.tsx`, a popover with every app; its pencil edits the pins: click to pin or unpin, drag or Alt+arrow to reorder), Settings and the account button (menu: name, email, Sign out, which unsubscribes this browser's reminders first). Each item lands where that app was last open (`/settings` belongs to no app and isn't remembered), and its route chunk is warmed (`manifest.preload`) when the pointer or focus reaches it. The middle scrolls when the window is short. Under 768px the rail is a tab bar along the bottom (Settings moves into the account menu so eight entries fit across 390px; more scroll inside the bar, never the page) and the sidebar is a drawer. A new app appears in the launcher and in Cmd-K's "Go to" commands by its manifest and its line in `APPS`; it also needs its routes in `router.tsx` and its sidebar in `AppShell`. Cmd-K lists "Go to <app>" for every app and rail link, the pinned ones first.
- Keyboard (`src/keyboard/`, PLAN-keyboard.md): `catalog.ts` is the one list of shortcuts (id, key specs, label, section); the `?` sheet (`ShortcutsSheet`), Settings and key hints read it. `keys.ts` parses specs (`mod+k`, `g d`, `?`, `alt+mod+1`; `mod` is ⌘ or Ctrl, a symbol ignores the Shift it took, Alt matches letters and digits by physical key) and formats keycaps for Mac and others. `shortcuts.ts` is the one window `keydown` listener, installed by `AppShell`; pages bind with `useShortcut(id, run)` (newest binding wins; `run` returning false leaves the key alone). It skips events already handled (CodeMirror's ⌘K link), plain keys while typing or while a dialog, menu or listbox is open, Enter or Space on a control, arrows on a video, and character keys when the member turned single-key shortcuts off (Settings → Keyboard, `hearth:single-keys` in this browser; WCAG 2.1.4). Entries with `handledBy` (CodeMirror, the Tables grid, Esc in dialogs) are listed for the sheet but never bound. `catalog.test.ts` fails on two shortcuts sharing keys where both can be live, and on browser- or Mac-owned keys (`RESERVED`). `useAppShortcuts` (AppShell) binds `g` then a letter (`GO_KEYS`; the rail's tooltips name them) and the app-wide defaults for `c` (the app's new page, or its new-title box) and `/` (Command-K) as fallback bindings, which any page's own binding outranks (Tasks' quick add, Notes' composer, Docs' New doc in `FileTree`, Boards' new board). ⌘\ hides the sidebar, or toggles the drawer on a phone. Command-K's actions come from `keyboard/commands.ts`: a registry of commands (id, title, group page/create/ask/go/prefs, icon, synonyms, shortcut, optional `confirm`, `run(query)`). `useBuiltInCommands` (AppShell) registers Create, Go to and Preferences; a page adds its own with `useCommands` and they show under "On this page". Matching is word-prefix over title, synonyms and group name (an `anyQuery` command such as Ask the assistant matches anything and shows last); doc results stay above actions so Enter opens the best doc, and the highlighted row is always the first shown. A pasted link offers Save link and "task …" offers Add task, above everything. Search results open in the app that owns their folder (`appForFile`). Lists take `j`/`k` through `keyboard/listKeys.ts`: a row's main link or button carries `data-list-item`, and row keys act on the focused row (`focusedRow`).
- `AppShell`, `Sidebar`, `SpaceSwitcher`, `FileTree` (lazy per directory, drag to move, context menu: new doc, new folder, rename, move, delete), `TopBar` (breadcrumbs, `SaveState`, reading-view toggle, Share menu).
- `MarkdownEditor`: CodeMirror 6, `@codemirror/lang-markdown` with GFM, our live-preview extension (`livePreview.ts`): heading sizes, hidden markers on inactive lines, bold/italic/strike/code styling, clickable links, toggleable `- [ ]` checkboxes, inline image widgets, fenced-code highlighting, folded frontmatter. Shortcuts: Cmd-B/I/K, `[[` autocomplete (writes a relative link). Paste/drop image → upload → insert link.
- `ReadingView`: `react-markdown` + `remark-gfm` + `rehype-highlight`, callouts rendered.
- `HistoryPanel` (commits, click to view version, compare → `DiffView`, Restore), `PropertiesPanel` (frontmatter fields), `ConflictResolver` (ours/theirs side by side, editable result).
- `CommandK` (`cmdk`): titles first, then full text; Enter opens.
- `useDocument(space, path)`: load → `{content, blobOid}`; edits → debounced autosave to the server buffer is **not** a thing in P0: the client holds the draft and PUTs after `idleCommitMs` of no typing, on route leave, and on Save version. On `merged` adopt the content; on 409 open the resolver. On WS `changed` for the open path with no local edits → refetch.
- Icons: `public/favicon.svg` is the Hotsauce bottle; `node apps/web/scripts/render-icons.mjs` renders the install icons from it (`icon-192`/`icon-512` on a rounded cream tile, `apple-touch-icon` and `icon-maskable-512` full-bleed with the bottle in the safe zone). An organization's own mark replaces the bottle in the app, not in these files.
- Offline: the PWA caches the shell; an unsaved draft is kept in `localStorage` keyed by `space:path:blobOid` and offered on reload.

Design brief:

- Warm hearth palette as CSS tokens on `:root` with a dark theme: charcoal and ash neutrals, one ember accent (orange-red), paper-warm light mode. Never pure black/white; atmospheric background (subtle radial warmth), not flat.
- Type: **Fraunces** (display, titles) + **IBM Plex Sans** (UI, body) + **JetBrains Mono** (code). Loaded from Google Fonts. No Inter/Roboto/Arial/system.
- One orchestrated load animation (the shell "warms up": sidebar and editor fade/slide in once, ~400 ms), no scattered micro-animations.
- Fast above all: no layout shift on load; editor mounts before the tree finishes.

Test IDs (used by e2e, keep stable): `sidebar`, `space-switcher`, `file-tree`, `tree-item` (with `data-path`), `new-doc`, `new-folder`, `editor`, `editor-content`, `save-state` (with `data-state`: dirty|saving|saved|committed|conflict), `save-version`, `history-toggle`, `history-item` (with `data-oid`), `restore`, `reading-toggle`, `reading-view`, `cmdk`, `cmdk-input`, `search-result`, `conflict-banner`, `conflict-resolver`, `resolve-use-mine`, `resolve-use-theirs`, `resolve-save`, `share-menu`, `share-to-team`, `dev-signin-email`, `dev-signin-submit`, `app-rail`, `app-switch-<id>`, `app-link-<id>`, `rail-recording`, `settings-link`, `account-menu`, `account-email`, `sign-out`, `sidebar-app-name`, `cmdk-app-<id>`.

## 5. Testing strategy

| Layer | Tool | Where | What |
| --- | --- | --- | --- |
| Unit | Vitest | `packages/format/src/**/*.test.ts`, `apps/server/src/**/*.test.ts`, `apps/web/src/**/*.test.tsx` (jsdom + Testing Library) | Pure logic, components with logic |
| Integration | Vitest | `apps/server/test/integration/` | GitStore against file:// bare repos; Index with real SQLite; hosts against LocalHost always, Forgejo when `FORGEJO_URL` is set, GitHub when `GITHUB_TOKEN` is set; API routes with `app.request()` in dev-auth mode over a temp data dir |
| E2E | Playwright | `e2e/` | Full stack: server started by Playwright with `AUTH_MODE=dev HOST_KIND=local POLL_INTERVAL_MS=1000 IDLE_COMMIT_MS=500` and a temp `DATA_DIR`; Chromium desktop + a mobile viewport project |

E2E flows for Phase 0/1: sign in; create doc → type → committed (history shows the commit with the right author); edit from "outside" (the test pushes to the bare remote) → appears within 2 s; concurrent edit → `merged` adopts content; true conflict → banner → resolver → resolved commit; move a doc → links still resolve; share to team; Cmd-K finds by title and by body; image paste → appears; reading view renders; mobile viewport can open and edit.

Scripts: `pnpm test` runs unit + integration; `pnpm test:e2e` runs Playwright; CI runs all three plus `pnpm lint` and `pnpm typecheck`. Coverage is reported, not gated.

## 6. Dev and deploy

- `pnpm dev`: server with `AUTH_MODE=dev HOST_KIND=local` on :3000 and Vite on :5173 proxying `/api` and `/ws`. Clerk mode: set `AUTH_MODE=clerk`; keys come from root `.env.local` (pulled with `clerk env pull`).
- The server loads the repo-root `.env.local` (found relative to its own file, not the working directory) when present; variables already in the environment win. It serves `apps/web/dist` (also found relative to its own file) with an SPA fallback to `index.html`, or a placeholder page when there is no web build.
- `hearth reindex [space]`: `pnpm --filter @hearth/server reindex [space]` in development, `node apps/server/dist/cli/reindex.js [space]` in the image. Rebuilds `files` and `spaces` from the clones; keeps `index.sqlite`.
- `docker compose up forgejo` for the Forgejo adapter (http://localhost:3300, admin created by the compose init script, token written to `.data/forgejo-token`).
- `Dockerfile` builds both apps; runtime image has `git`; `DATA_DIR=/data`. `deploy/fly.example.toml` mounts a volume at `/data` (`scripts/deploy-fly.sh`).

## 7. Hearth Meetings: foundation (Phase 2)

Scope of this phase: everything in the Meetings PRD P0 that can be built and tested behind fakes, plus the real Chrome capture flow. Real ASR and real Claude calls are implemented behind interfaces and switched on by config; tests never call paid APIs.

### 7.1 Server (`apps/server/src/meetings/`)

```ts
// transcription
export type Track = 'me' | 'them'
export interface TranscriptSegment { track: Track; speaker: string; at: number; durationMs: number; text: string; final: boolean }  // at = ms of audio on the track before the segment: ms from session start, less any paused time
export interface TranscriberSession {
  sendAudio(track: Track, pcm16: Uint8Array): void      // 16 kHz mono PCM16 little-endian per track
  finish(): Promise<void>                               // flushes; after it resolves no more events
  on(event: 'segment', cb: (seg: TranscriptSegment) => void): () => void
  on(event: 'error', cb: (err: Error) => void): () => void
}
export interface Transcriber { start(opts: { sessionId: string; language?: string; vocabulary?: string[] }): Promise<TranscriberSession> }
// FakeTranscriber: deterministic; every `bytesPerSegment` (default 32000 = 1 s) of audio on a track emits one final segment "<track> segment <n>" (optionally a partial first). Used when ASR_PROVIDER=fake (the default in dev and test).
// DeepgramTranscriber: one WebSocket per track to wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1&interim_results=true&smart_format=true&model=nova-3[&language=..][&keyterm=<word>...] (nova-3 takes custom words as repeated `keyterm`, not `keywords`), header `Authorization: Token <DEEPGRAM_API_KEY>`; maps Results messages (channel.alternatives[0].transcript, is_final, start, duration) to segments; opens a track's socket on its first audio, sends KeepAlive while idle, reopens after a drop (2 s backoff, offsetting `at` by the audio already sent, queueing up to 30 s), errors are `asr_error`; sends CloseStream on finish. Unit-tested against recorded message fixtures with a fake ws server; never called live in tests.

// language model
export interface LLM { complete(req: { model: string; system: string; messages: Array<{ role: 'user' | 'assistant'; content: string }>; maxTokens?: number }): Promise<{ text: string; usage: { input: number; output: number } }> }
// FakeLLM: deterministic; records calls; returns canned text chosen by a `respond(req)` callback in tests.
// AnthropicLLM: `@anthropic-ai/sdk`, `new Anthropic()` (key from ANTHROPIC_API_KEY), `client.messages.stream({ model, max_tokens, system, messages }).finalMessage()`; no `thinking` param, no prefill; `max_tokens` 16000 unless given; text blocks concatenated. Typed SDK errors (`Anthropic.APIError` subclasses) and a `refusal` stop reason map to HearthError('llm_error', 502) with a short message; the detail is logged server-side only.

// sessions
export interface MeetingSession { id: string; owner: string /* email */; space: string; title: string; template: string; calendarEventId?: string; meetCode?: string; startedAt: string; keepAudio?: boolean; state: 'recording' | 'paused' | 'stopped' | 'saved'; rawNotes: string; segments: TranscriptSegment[] }
export class MeetingSessions {               // in-memory + DATA_DIR/sessions/<id>/{meta.json, me.pcm, them.pcm, segments.jsonl} for crash recovery
  create(principal, { title?, template?, calendarEventId?, meetCode?, tz? }): Promise<MeetingSession>   // meetCode: the Meet call (`abc-defg-hij`), so a resumed capture asks the extension for that tab; tz: the owner's IANA zone (default UTC); title defaults to the event's, else "3:04 PM Meeting"
  attachAudio(id, socket: { send(msg), close(code, reason) }): Promise<{ resumeFrom: { me, them }; audio(frame: Uint8Array): void; detach(): void }>   // see 7.3; a newer socket replaces the older
  setRawNotes(id, text): Promise<void>
  pause(id) / resume(id): Promise<MeetingSession>
  setKeepAudio(id, keep): Promise<MeetingSession>   // the member's Keep audio choice, in meta.json; shown as `keepAudio` on the session
  stop(id, { keepAudio?, notes? }): Promise<SavedMeeting>   // { space, path, transcriptPath }; `notes`, when given, replaces the raw notes first (so a `notes` frame queued behind audio can't overtake the last words typed); transcriber.finish(), write files (7.4) to the owner's personal space, commit `meetings: capture "<title>"` authored by the owner, state 'saved', delete pcm files unless keepAudio (the stop's, which is stored on the session so a retried stop keeps it, else the member's choice from `setKeepAudio`, else KEEP_AUDIO; a stop asking to keep audio with no AUDIO_STORE is 400). Kept audio uploads in the background after the save: each non-empty track as `meetings/<space>/<id>/<track>.wav` (16 kHz mono PCM16 WAV) to the AudioStore, then a second commit `meetings: keep audio "<title>"` adds `.hearth/meetings/audio/<id>.yaml` (`{ id, note, store, tracks: { me?, them?: { key, bytes, seconds } } }`), then the PCM is deleted; a failed upload logs and leaves the PCM on the volume (meta `audioPending`), and the sweep tries again 10 minutes later, as does the next startup. `close()` gives uploads in flight 20 s. `settled()` awaits the uploads. Retryable after a failure (it rewrites the files it already committed, matched by the note's `id`, rather than adding `-2` copies); idempotent once saved; path choice and commit are serialized per space
  get(id, principal): MeetingSession          // owner only: not_found, or forbidden for anyone else
  recover(): Promise<number>                  // at startup: reloads every unsaved session from disk (bytes from the pcm sizes, finals from segments.jsonl)
}
// MeetingSession also carries `saved?: SavedMeeting` once saved. A session's transcriber starts on its first socket and is
// finished (and its audio files closed) 60 s after its last socket goes, restarting (with `at` offset by the audio already held) on the next one.
// After a save the session directory keeps only meta.json (and the pcm files when kept); saved sessions aren't reloaded.
// Memory and lifetime: once saved, only the `saved` record stays in the in-memory map (segments and raw notes are dropped; `get`
// still answers with state 'saved' and `saved`). A session with no socket attached for SESSION_IDLE_STOP_MINUTES (default 120),
// or older than SESSION_MAX_HOURS (default 8), is stopped and saved by the server as if the owner had pressed Stop; the sweep runs
// every minute and once inside `recover()`, so a tab that died never records forever or holds a paid ASR stream open.
// `list(principal)` returns the owner's unsaved sessions (newest first) for GET /api/meetings/sessions, so Home can offer Resume / Stop.
// A recovered session's idle time counts from when its files were last written. A second `stop` while one is running joins it
// (its `notes` are ignored). The sweep retries a session whose save failed once it is past the idle limit.

// enhancement
export interface EnhanceInput { title: string; template: TemplateDoc; rawNotes: string; transcript: TranscriptSegment[]; attendees: string[]; calendar?: { title: string; description?: string } }
export function buildEnhancePrompt(input: EnhanceInput): { system: string; user: string }
export function assembleEnhancedNote(input: { frontmatterText: string; rawNotes: string; modelMarkdown: string }): { text: string; aiRanges: Array<[number, number]> }
//   - lines of modelMarkdown that, trimmed, equal a non-empty trimmed line of rawNotes are "user" lines (trimming both sides keeps an indented raw bullet the member's); all others, blank lines included, are AI lines; aiRanges = 1-based inclusive line ranges of AI lines in the body (line 1 = the first line after the frontmatter). The body takes the frontmatter's line endings
//   - the prompt instructs the model to keep every raw-notes line verbatim, in order, and to add structure and detail around them following the template's sections
export class Enhancer { constructor(llm: LLM, opts: { model: string }); enhance(input: EnhanceInput): Promise<{ markdown: string; usage }> }
//   markdown = `# <title>` + the model's body (a code fence around it or a title heading of its own removed); raw-notes lines the
//   model dropped are appended under `## More of your notes`, so the member's words are never lost. An empty answer is llm_error.
//   Outside parties shape the prompt (event description, "Them" speech), so on AI lines (never the member's own raw lines) markdown
//   images and `<img>` tags whose URL is absolute (`http:`, `https:`, `//`, `data:`) are removed before the note is written; the
//   SPA's live preview fetches image URLs as soon as a note opens, and auto-enhance opens notes without a click.
export function enhanceNote(deps, principal, { space, path, template?, force? }): Promise<{ path, aiRanges, usage }>   // POST /api/meetings/enhance
//   reads the note, `.hearth/meetings/raw/<id>.md` and the transcript (frontmatter `transcript`, beside the note; missing → 400),
//   rewrites the body, patches `template`, `ai_ranges` and `models: { enhance: ENHANCE_MODEL, enhanced_blob }` in place, commits
//   `meetings: enhance "<title>"` as the member with the note as base. Edit guard (409 conflict unless force): `models.enhanced_blob`
//   is the git blob oid of the body Hearth wrote (the note's own blob can't be stored inside itself), so any body edit since the
//   last enhance refuses; a never-enhanced note refuses unless its latest commit is its capture. Also 409 if the note changes
//   while the model runs. Known gap: an outside push that GitStore.commit merges cleanly (status `merged`) is committed with
//   ai_ranges computed for the unmerged body; the next enhance then needs `force`.
// templates: built-ins in apps/server/src/meetings/templates/*.md (general, one-on-one, customer-call, candidate-interview, standup, pitch, brainstorm): frontmatter { id, name, description } + section headings with HTML-comment instructions. Custom templates: `.hearth/meetings/templates/*.md` in the team or personal space (read via GitStore). `MeetingTemplates.listTemplates(principal)` merges built-ins + space templates (a custom template with a built-in's id replaces it; personal beats team); `getTemplate(principal, id)` is 400 for an unknown id. The build copies the built-in .md files into dist.

// chat
export interface ChatScope { space?: string; meetingPath?: string; folder?: string; person?: string; company?: string }
export class MeetingChat { constructor(index: Index, git: GitStore, llm: LLM, opts: { model: string; spaces: SpaceService }); ask(principal, { question, scope }): Promise<{ answer: string; citations: Array<{ space: string; path: string; line: number; text: string }>; usage }> }
//   retrieval: Index.search (any word, stop words dropped) over kind in (meeting, transcript) in visible spaces picks the top 8 files
//   by bm25 (a meeting scope takes its note + transcript; person/company take the 20 newest matching notes + their transcripts;
//   folder is a path prefix under meetings/); they are read from Git and cut into passages (transcripts every 3 lines, notes by
//   chunkMarkdown at 800 chars); Index.rankPassages picks the top 12 by bm25 (a single meeting is topped up in file order), each sent
//   as `[n] <space>/<path>#L<line>: text`, line = 1-based file line where the passage starts. Citations come back in order of first
//   use and the answer's markers are renumbered to match (`[1]` is citations[0]; unknown numbers dropped; a combined marker such
//   as `[2, 5]` is written back as `[1][2]`, one marker per citation, which is what the web links). Nothing found → a fixed
//   answer, no model call. Semantic retrieval is P1.

// calendar
export interface CalendarEvent { id: string; title: string; start: string; end: string; attendees: Array<{ email: string; name?: string }>; description?: string; meetLink?: string }
export interface CalendarSource { upcoming(principal, range: { from: string; to: string }): Promise<CalendarEvent[]> }
// Since 2026-11-10 every reader goes through the cached calendar of §7.8 (`CachedCalendar` over `CalendarSync` and `GoogleCalendarHttp`, token via Clerk: `clerk.users.getUserOauthAccessToken(userId, 'google')`, `data[0].token`). Cancelled, all-day and declined events are skipped, rooms aren't attendees; no token, or Google answering 401/403 (not a rate limit), is 403 forbidden (reconnect Google); other failures host_error. Dev auth runs the same sync against the in-memory `FakeGoogle`; `FakeCalendar` remains a `CalendarSource` for tests. `findEvent(calendar, principal, id, at)` looks an event up a day either side of `at`. Scope `calendar.readonly` must be enabled on the Clerk Google connection (dashboard task, noted in STATUS.md).
```

Config additions: `ASR_PROVIDER=fake|deepgram` (default fake in dev/test, deepgram in production), `DEEPGRAM_API_KEY` (required with deepgram), `LLM_PROVIDER=fake|anthropic` (default fake in dev/test, anthropic in production), `ANTHROPIC_API_KEY` (required with anthropic), `ENHANCE_MODEL=claude-sonnet-5-5`, `CHAT_MODEL=claude-opus-5-5`, `CLEANUP_MODEL=claude-haiku-5-5` (§7.11), `KEEP_AUDIO=false` (whether Stop keeps audio when the client doesn't say), `AUDIO_STORE=none|local|r2` (default r2 when `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET` are all set, else local (`DATA_DIR/kept-audio/`, on the volume); none hides Keep audio and Clips; `KEEP_AUDIO=true` with none is refused). Routes: `GET /api/meetings/settings → { keepAudio: { available, byDefault } }`; `GET /api/meetings/audio?space&id&track → audio/wav` for anyone who can see the space, reading the key from the pointer file, which must be the meeting's own key in that space. Meeting reminders (PRD §6.1): `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` (both or neither; off without them), `GET /api/meetings/reminders → { publicKey | null }`, `POST /api/meetings/reminders { subscription }`, `DELETE /api/meetings/reminders { endpoint }` (own subscriptions only). Subscriptions and sent reminders live on the volume (`DATA_DIR/push/state.json`), not Git or SQLite: they're device state. `MeetingReminders` ticks every 30 s; for each subscribed member it reads the calendar for the next 90 s and pushes `{ title: 'Take notes for “<title>”?', body, url: '/meetings/start?event=<id>', tag }` once per event with attendees to each of their browsers, forgetting subscriptions the push service answers 404/410. The service worker imports `public/push-sw.js` for the push and click handlers; a click focuses an open Hearth tab and moves it in-app (`hearth:navigate` message, `src/lib/swNavigate.ts`), never by a page load, which would end a recording there, else opens a window. The toggle is on Meetings home; each visit re-sends a subscribed browser's subscription (resubscribing if the server's key changed), so one the server dropped comes back. Sign out unsubscribes the browser first, so the next person on it doesn't get the last member's reminders. Production refuses `fake` providers. `createServices(config, { transcriber?, llm?, calendar? })` takes stand-ins for tests.

Index: `files` gains a `frontmatter TEXT` column (JSON of the parsed frontmatter, null when none) so meeting lists can show date/attendees without reading git; `Index.listFiles({ space, kind, prefix, limit, order: 'path' | 'date_desc' })` added (`FileRow.frontmatter` is the parsed object). `kind` is `meeting` for `meetings/**/*.md` that aren't `*.transcript.md`, `transcript` for those. `search()` also takes `kinds`, `prefix` and `anyTerm` (match any word of a question); `rankPassages(q, passages, limit)` ranks short texts with the same tokenizer and bm25. The migration forgets every sync point, so the next sync re-indexes each space and fills `frontmatter`.

### 7.2 API (`/api/meetings`, `/api/calendar`)

```
GET  /api/calendar/upcoming?from=&to=                     → CalendarEvent[]
GET  /api/meetings/templates                               → [{ id, name, description, source: 'builtin' | 'team' | 'personal' }]
GET  /api/meetings?space=&from=&to=&person=&company=&folder= → [{ space, path, title, date, duration_min, attendees, companies, template, hasTranscript }]  (from index frontmatter; visible spaces only)
POST /api/meetings/sessions        { title?, template?, calendarEventId?, meetCode?, tz? } → MeetingSession (owner's personal space; 403 when it isn't available)
GET  /api/meetings/sessions        → MeetingSession[] (the caller's unsaved sessions, `recording`, `paused` and `stopped` alike, newest first)
GET  /api/meetings/sessions/:id    → MeetingSession (owner only)
PUT  /api/meetings/sessions/:id/notes { text } → 204
POST /api/meetings/sessions/:id/pause | resume → MeetingSession
PUT  /api/meetings/sessions/:id/keep-audio { keep } → MeetingSession   (the member's choice, used by any stop that doesn't say; keep with no AUDIO_STORE is 400)
POST /api/meetings/sessions/:id/stop { keepAudio?, notes? } → { space, path, transcriptPath }   (files committed; enhancement NOT yet run)
POST /api/meetings/enhance         { space, path, template?, force? } → { path, aiRanges, usage }  (re-runnable; 409 conflict if the note was edited since Hearth last wrote it, unless `force`)
POST /api/meetings/speakers        { space, path, names: { "Speaker 1": "Priya Shah" }, transcriptBlobOid? } → { transcriptPath, renamed }  (§7.10; 400 for "Me", a label not in the transcript, or a name with `*`/`:`; 409 while the transcript is being cleaned up (§7.11) or when it is no longer the `transcriptBlobOid` the panel showed; one commit `meetings: name speakers in "<title>"`)
POST /api/meetings/import/granola  { meetings: GranolaMeeting[] (1–100), tz } → { imported, skipped, space }  (§7.12; session only)
POST /api/meetings/chat            { question, scope } → { answer, citations }
WS   /ws/meetings/:id              audio + live transcript (7.3)
```

`GET /api/meetings`: newest first; `from`/`to` are ISO instants (`to` exclusive; a bare date is midnight UTC); `person` is an email and matches an attendee exactly (case-insensitive, the `<email>` part of `Name <email>` or a bare email, never a substring); `company` matches a company domain exactly, case-insensitively; chat scopes use the same matching; `folder` is a folder under `meetings/`; only notes whose frontmatter says `type: meeting`. `GET /api/calendar/upcoming` defaults to the next 24 hours. Session routes check the owner first (403 for anyone else, 404 for an unknown id); pause/resume/notes on a stopped session are 409.

### 7.3 Audio WebSocket protocol

Client opens `/ws/meetings/:id`, sends the same first-message auth as `/ws` (`{type:'auth', token|devUser}`), gets `{type:'ready', sessionId, resumeFrom: { me: bytes, them: bytes }}`. Then:
- binary frames: byte 0 = track (0 = me, 1 = them), bytes 1.. = PCM16 LE 16 kHz mono. Server appends to the track's `.pcm` file and forwards to the transcriber.
- text frames from client: `{type:'notes', text}` (debounced raw notes), `{type:'pause'}`, `{type:'resume'}`.
- text frames from server: `{type:'segment', segment}` (partials have `final:false` and replace the previous partial on the same track), `{type:'state', state}`, `{type:'error', message}`.
- Reconnect: client reopens, server replies with `resumeFrom` byte counts so the client's local ring buffer (IndexedDB) can resend what the server never got.
- `maxPayload` 256 KiB; frames rejected before auth.
- `ready` is followed by `{type:'state', state}`. Close codes: 4401 not authenticated (bad credential, timeout, or any frame other than the auth message before `ready`), 4403 not the owner, 4404 no such session or already saved/stopped, 4409 replaced by a newer connection to the same session, 1000 `saved` after stop, 1009 a pre-auth text frame over 16 KiB. Bad frames after `ready` (unknown track byte, odd-length PCM, unknown message) get `{type:'error'}` and are ignored.
- Pause is the client's recorder's job: while paused it captures nothing, so nothing is sent. The server accepts, counts and transcribes any audio that does arrive while its state is `paused` (a pause made over HTTP while the socket was down must not make the server drop the pre-pause audio the client replays on reconnect, and counting it keeps `resumeFrom` equal to the client's offsets). The member's last click (Pause or Resume) is the client's intent, delivered or not; the recorder follows the intent, so a member who pressed Pause is never recorded until they press Resume, whatever the network did. After every `ready` the client re-sends a pending intent; a `state` message that matches it is the acknowledgement, one that contradicts a still-pending intent is ignored (the re-sent intent produces the matching state next), and only when nothing is pending does a `state` message move the recorder (a pause from another device, or a server-side stop).
- A protocol ping goes out every 30 s; a client that didn't answer the previous one is dropped (its session detaches, so the transcriber idles out).

### 7.4 Files written on stop

`meetings/YYYY/MM/YYYY-MM-DD-<slug>.md` (note; frontmatter per PRD §7 with `id, type: meeting, title, date, duration_min, attendees, companies, template, calendar_event_id?, transcript, ai_ranges: [], models: {}`; body = template section headings + the raw notes under the first section until enhanced), `meetings/YYYY/MM/YYYY-MM-DD-<slug>.transcript.md` (lines via `formatTranscriptLine`, speaker `Me`/`Them` until diarization), `.hearth/meetings/raw/<id>.md` (raw notes verbatim). The note's body starts `# <title>` right after the frontmatter; the transcript file starts `# <title>: transcript`, then one line per final segment in time order. A second meeting with the same title on the same day gets `-2`, `-3`… on both files. `duration_min` is the longest track's audio, rounded to minutes. `meetingPaths` and `formatTranscriptLine` come from `@hearth/format`; the date is the session start in the OWNER's timezone, which the client sends at session creation (`tz: 'America/New_York'`), never the server's.

### 7.5 Web (`apps/web/src/apps/meetings/`)

Routes: `/meetings` (home: today's and upcoming calendar events with "Take notes" buttons, a "New meeting" button, then the meeting list grouped by day with filters), `/meetings/start?event=` (Start screen: title, template picker, two capture modes: **Meet tab + mic** (`getDisplayMedia({ video: true, audio: true, selfBrowserSurface: 'exclude', systemAudio: 'exclude' })` with the video track stopped immediately, plus `getUserMedia({ audio: true })`) and **Mic only** (in-person / phone on speaker); an "audio is arriving" check within 3 s per track with a clear retry; the guidance text tells the user to pick the Meet tab and tick "Share tab audio"), `/meetings/live/:id` (recording indicator in the tab title and chrome, elapsed time, pause/resume/stop, the Docs editor in compact mode as the notepad with `{type:'notes'}` sync, a collapsible live transcript panel with Me/Them labels, calendar context collapsed at top), `/meetings/:space/*` (the Docs editor page with a Meetings header: date, attendees, template, **Enhance / Re-enhance** button with template picker, a transcript side panel reading the sibling `.transcript.md`, AI-written ranges styled muted using `ai_ranges`, and a **Chat** panel scoped to this meeting), plus a cross-meeting chat at `/meetings/ask`.

Resilience rules for the live page: the controller's own Stop is never mistaken for a stop from another device (a `stopping` flag set before the notes are sent suppresses the "stopped elsewhere" handling; a failed stop clears it and shows the error with a retry, keeping the ring). A session found `stopped` but not `saved` (the save failed, or the tab died) shows "Save it now", which calls stop and opens the note; Home lists the member's unsaved sessions (from GET /api/meetings/sessions) with Resume / Stop. The editor is read-only while an enhance is running, so the member's keystrokes can't race the model's rewrite. The transcript is resolved everywhere (web panel; server enhance, chat and list) with `transcriptPathFor(notePath, frontmatter)` from `@hearth/format`: the frontmatter `transcript` file name beside the note, `null` when it is missing, not a string, contains `..` or starts with `/`; there is no fallback to the note's file name (a note without `transcript` has no transcript; enhance answers 400); the Docs rename-to-title offer is hidden on meeting notes (moving a note without its transcript is a known gap, see STATUS). Bytes the 5-minute ring already dropped (`skipped`) are persisted per session and track next to the notes draft, so a reload after a long outage doesn't resend audio the server has. The live page's error for a 403 says the meeting belongs to someone else, not "check your connection".

As built: `apps/web/src/apps/registry.ts` lists the Docs and Meetings manifests; one layout route wraps `/docs` and `/meetings` so switching apps keeps the session and sockets, and the app rail switches between them (§4, shell). A module-level live controller owns the recording so it survives navigation (a recording strip and the tab title "● Recording · <title>" show on every page). Session create always sends `title` (the event's, else the local "3:05 PM Meeting") and `tz`. On arrival at the note after Stop the client calls enhance once (the server's stop does not enhance); the **Enhance** button then re-enhances, and a 409 asks before resending with `force: true`. Chat citations are 1-based whole-file lines and link to `/meetings/<space>/<path>#L<line>`. Close code 4409 (another connection took the session) is final on the client, like 4403/4404; 4401 retries with a fresh token. Known: `/meetings/:space/*` would shadow a space named `start`, `live` or `ask`; `ai_ranges` aren't rewritten after the member edits, so shading can drift until the next enhance.

Audio pipeline: `AudioContext` at 16 kHz where supported (else resample in an `AudioWorklet`), one worklet per track producing PCM16 frames of 100 ms, an IndexedDB ring buffer of the last 5 minutes per track for reconnects, a `MeetingSocket` wrapper with reconnect + resume. Unit-test the PCM conversion and the ring buffer; the capture permission flow is tested in e2e with Chromium's fake media devices (`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`) in **mic-only** mode; the tab-share mode is verified manually (noted in STATUS.md).

Test IDs: `meetings-home`, `calendar-event` (`data-event-id`), `take-notes`, `new-meeting`, `meeting-list`, `meeting-item` (`data-path`), `start-title`, `start-template`, `capture-meet-tab`, `capture-mic-only`, `audio-check` (`data-state`: waiting|ok|failed), `start-recording`, `live-notepad`, `live-transcript`, `transcript-segment` (`data-track`), `recording-indicator`, `pause`, `resume`, `stop`, `enhance`, `enhance-template`, `ai-text`, `transcript-panel`, `meeting-chat-input`, `meeting-chat-send`, `chat-answer`, `chat-citation`.

### 7.6 Chrome extension (`apps/extension/`)

A Manifest V3 extension. One generic build serves every server: the server offers it at `/downloads/hearth-meetings-chrome.zip` with its own address and name written in (`server.json`, and a manifest whose content script `bridge.js` runs only on that origin; `apps/server/src/extension`). A copy with no `server.json` (the Chrome Web Store) asks for the server's address on first use, asks Chrome for that one site (`optional_host_permissions`, `chrome.permissions.request`), checks `/api/health`, and registers the bridge there with `chrome.scripting`; the popup's "Change server" does the same later. The person's choice is kept in `chrome.storage.local` and wins over `server.json`. `/meetings/extension` explains Load unpacked. Permissions: `tabCapture`, `storage`, `activeTab`, `contextMenus`, `scripting`, host `https://meet.google.com/*`.

- The service worker puts a dot on the toolbar icon on Meet call tabs (`meet.google.com/xxx-xxxx-xxx`). The popup on a call offers **Take notes** (shortcut Alt+Shift+H opens it). Clicking it records the tab as invoked (`chrome.storage.session`) and opens `/meetings/start?via=extension&meet=<code>` next to the call.
- Chrome only lets an extension capture a tab the person invoked it on, so the invoked list is the allow-list. The Start page's **Meet tab + mic** asks the bridge over `window.postMessage` (`{source:'hearth-page', type:'hello'|'capture-meet', id, code?}`; replies `source:'hearth-extension'`; `apps/extension/src/protocol.ts`). `code` is the meeting's Meet code, from `?meet=` or the calendar event's Meet link. The worker calls `tabCapture.getMediaStreamId({ targetTabId, consumerTabId })` for the newest invoked tab still on that call; without a code, only for one invoked in the last 10 minutes, so a call left open from earlier is never captured by mistake. The page opens the stream id with `getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId } } })`. With no match the worker answers `not-invoked`, and the page falls back to the share picker. The worker answers only a content script on a Hearth origin.
- Capture mutes the tab for the person, so the page plays the call back through an `<audio>` element. It captures only after the mode click, so autoplay is allowed.
- No extension, no answer to hello within 300 ms, a refusal, or any error: `captureAudio` falls back to the share picker. The Start page asks the server which event the call belongs to (`GET /api/calendar/match?meet=`, §7.8).

### 7.7 Tests

- Server unit: fake transcriber determinism, Deepgram message mapping from fixtures, `assembleEnhancedNote` ranges (user lines verbatim, AI lines ranged, CRLF, empty raw notes), prompt builder includes template sections and attendees, chat citation resolution, calendar fixture parsing, binary frame parsing.
- Server integration: full session lifecycle over a real WebSocket against the app (create → auth → audio frames → segments arrive → notes → stop → files committed in the personal space with the right frontmatter and transcript lines → enhance with FakeLLM → `ai_ranges` set and user lines intact → re-enhance refused without force after an edit → chat returns citations pointing at real lines); reconnect resumes with correct byte counts; a non-owner gets 403 on every session route; production config refuses fake providers.
- E2E (Playwright, fake media devices, FakeTranscriber/FakeLLM): home shows the fake calendar; Take notes → Start (mic only) → audio check ok → live transcript shows segments → type notes → Stop → the note opens with the transcript panel → Enhance → AI text visible and the typed line still present → chat answers with a citation; the meeting appears in the list; `/meetings/ask` across meetings returns a citation.

### 7.8 Google Calendar sync (read-only, `apps/server/src/meetings/calendar/`)

Scope is `calendar.readonly`: Hearth never writes to Google, registers no push channels and creates no events.

**Cache.** `DATA_DIR/calendar/cache.sqlite` (better-sqlite3), rebuildable from Google: tables `members` (a member's principal as last seen; every calendar route, reminder tick and Start registers it), `sync_state` (per member and calendar: `sync_token`, `full_synced_at`, `synced_at`), `events` (per member, calendar and event id: the mapped `CalendarEvent` as JSON plus `start`/`end` columns), `member_status` (`attempted_at`, `synced_at`, `error`), `calendar_choices` (extra calendars a member picked; primary is always synced). Deleting the file resets choices to primary only and the next sync refills it.

**Google client.** `GoogleCalendarHttp` wraps `GET /calendar/v3/calendars/<id>/events` and `GET /calendar/v3/users/me/calendarList` with the Clerk token. A full sync asks `timeMin = now − 30 days`, `timeMax = now + 15 days`, `singleEvents=true`, `maxResults=250`, following `pageToken` until `nextSyncToken`, and replaces that calendar's cached events. An incremental sync sends only `syncToken` (plus `singleEvents=true`) and applies the changes. HTTP 410 (token expired) clears the token and does a full sync in the same pass. A full sync also runs when the last one is over 24 hours old, so instances entering the 14-day horizon appear. Every Google request and the Clerk token call time out after 10 s, so one hung member can't stall reminders or a shutdown. Errors: no token, 401, or 403 that isn't a rate limit → `forbidden` ("reconnect Google"); 404 → `not_found`; anything else → `host_error`.

**Mapping.** `classifyGoogleEvent(item)` → a `CalendarEvent` or `null` (remove from the cache): cancelled, all-day and declined-by-me events are null; rooms aren't attendees. On a calendar other than primary, Google's `self` is that calendar's owner, so an event is kept only when the member organizes it or is an attendee who hasn't declined. A removed id also removes cached instances whose `seriesId` is that id (a whole series deleted). `CalendarEvent` gains `seriesId?` (Google `recurringEventId`) and `calendarId?`. The Meet link is `hangoutLink`, else the video entry point of `conferenceData`. Reading dedupes an event in two calendars by id, preferring primary.

**Sync.** `CalendarSync.syncAll()` runs every 5 minutes (`CALENDAR_SYNC_MINUTES`, default 5) over registered members, one at a time; a member's passes are joined, never doubled. `refresh(principal, { maxAgeMs })` syncs only if the last attempt is older than `maxAgeMs`. Each calendar syncs on its own: primary failing is the member's failure; another calendar answering 403 or 404 is dropped from their choices, and other failures there are logged without stopping the rest. A sync of a calendar unticked meanwhile writes nothing back. A failure keeps the cache as it was and records the error; it's logged once per member until the message changes or a sync succeeds. Events whose end is more than 30 days ago are pruned after each sync.

**CachedCalendar** implements `CalendarSource` over the cache: `upcoming` returns cached events overlapping the range, in start order. A member who has never synced is synced inline first, and that sync's error is thrown (so a missing grant still shows "reconnect Google"); within a minute of such a failure, reads throw it again without asking Google; after one success, Google failures never empty the list. Reminders, Start, enhance and `/api/calendar/upcoming` all read through it. Each reminder tick calls `calendar.refresh(principal, { maxAgeMs: 60_000 })` for every subscribed member before reading, so a meeting moved, cancelled or added more than a minute ago is reminded (or not) as it now stands; if that refresh fails, the cached events are reminded anyway. The reminder key includes the start, so a moved event is reminded at its new time.

**Dev and test.** Without Clerk, the same `GoogleCalendarHttp` runs against `fakeGoogleFetch(model)`, an in-memory Google (`FakeGoogle`) with sync tokens and 410s; the token is `fake-token:<email>`. Each member is seeded on first sight with `FakeCalendar.events()` (Acme sync in a minute or two with Meet code `abc-defg-hij`, series `fake-acme-series`; Design review later) plus past meetings for coverage (Pipeline review, series `fake-pipeline`, yesterday and a week ago; Intro call with Bolt two days ago; a declined Offsite planning yesterday) and a second calendar `team@fake` ("Acme team"). Production refuses the fake. `FakeCalendar` still works as a `CalendarSource` override in tests. With `NODE_ENV=test` only, `/api/test/*` exposes hooks for e2e: `POST /api/test/calendar/add { id, title, startsInSeconds, minutes?, meetLink? }` (with Jo Park as a guest), `POST /api/test/calendar/move { id, minutes }`, `POST /api/test/calendar/cancel { id }`, `POST /api/test/calendar/sync` (sync the caller now), and with `PUSH_SENDER=record` a recording push sender: `GET /api/test/pushes`, `POST /api/test/reminders/tick`.

**Routes** (all for the signed-in member):

```
GET  /api/calendar/upcoming?from=&to=     → CalendarEvent[] (unchanged shape; from the cache)
GET  /api/calendar/status                 → CalendarStatus
POST /api/calendar/refresh                → CalendarStatus   // syncs unless the last attempt was < 60 s ago; Meetings home calls it on open
GET  /api/calendar/match?meet=<code>      → { event: CalendarEvent | null, by: 'meet' | 'now' | null }
GET  /api/calendar/coverage?from=&to=     → CoverageItem[]   // default the last 14 days up to now, newest first
GET  /api/calendar/calendars              → { calendars: CalendarChoice[] }   // live calendarList; 403/502 like upcoming
PUT  /api/calendar/calendars { ids: string[] } → { calendars: CalendarChoice[] }  // extra calendar ids; primary is implied; unknown ids 400
```

```ts
interface CalendarStatus { lastSyncedAt: string | null; error: string | null }   // error: the last failure's message, null after a success
interface CoverageItem { event: CalendarEvent; note: { space: string; path: string; title: string } | null }
interface CalendarChoice { id: string; name: string; primary: boolean; selected: boolean; color?: string }
```

- **Match** (the extension's Take notes, `/meetings/start?meet=`): the cached event whose Meet code is `meet`, nearest to now within 12 hours either side (`by: 'meet'`); else the event with someone besides the member overlapping now that started most recently and has no other Meet link (`by: 'now'`); else null. Start pre-fills title and attendees from it as it does for `?event=`.
- **Coverage**: cached events that have ended inside the range and have at least one attendee besides the member. `note` is a meeting note whose frontmatter `calendar_event_id` is the event's id, in a space the member can read, preferring their personal space. Meetings home shows "Recent meetings" with "Notes" (a link) or "No notes".
- **Series memory** (PRD P1): a meeting started from a recurring event writes `calendar_series_id: <recurringEventId>` in its frontmatter. Enhance passes the last three earlier notes with the same `calendar_series_id` (dated at least an hour before this note, not for the same calendar event, newest first, bodies capped at 4,000 characters each) as `<previous_meetings>`, with any `<previous_meeting(s)` text inside escaped. They come only from spaces no more widely read than the note's: for a note in the team space, the team space; for a personal note, the member's spaces; the prompt says they are context for continuity and open action items, never things said in this meeting.
- **Calendar picker**: Settings → "Calendars" lists the member's calendars with primary on and fixed; ticking others saves the choice, runs a fresh sync after any one in progress (so new ones fill at once), and drops cached events of removed ones.

Test IDs: `calendar-status`, `coverage`, `coverage-item` (`data-event-id`, `data-has-notes`), `coverage-note-link`, `calendar-choice` (`data-calendar-id`, checkbox inside).

### 7.9 Any app on this Mac (`apps/web/src/apps/meetings/audio/mac.ts`, `apps/dictate-mac/Sources/HearthDictate/MeetingCapture.swift`)

Capture mode `mac`, offered only when the page runs in the Hearth Mac app on macOS 14.2+ (the app injects `window.hearthMac = { meetingAudio: 1 }`). The page posts `{type:'start'}` to `webkit.messageHandlers.hearthMeetingAudio` and gets `{ok:true, session}` or `{ok:false, reason:'denied'|'no-mic'|'unsupported', message}`; then `{type:'pause'|'resume'|'stop', session}`. The app answers only the suite's main frame (by security origin), and accepts start only on a `/meetings` route. It sends `hearth-mac-audio` window events: `{session, type:'frames', me?, them?}` (base64, whole 100 ms frames of 16 kHz PCM16 LE) every 100 ms, or `{session, type:'ended', track}` when a track stops and one restart fails. A `Capture` with `frames` (no streams) goes straight to the socket (`frameRecorder`); the audio check reads the frames' peak. In the app, the mic is a plain `AVAudioEngine` input (restarted after a device change), and Them is a mono global process tap excluding the app's own process, in a private aggregate device, re-reading its rate when it changes. The tap starts before the mic. A reload, navigation or crashed page stops the capture. `HearthDictate --meeting-audio-probe <s> [--mic-only|--tap-only] [--out file]` checks it on a real Mac (run through `open` on the built `.app`). Echo: `dropEchoes` removes "me" lines that repeat a "them" line (four or more words, 70% of distinct words, starts within 4 s) from the transcript file and the Enhance prompt; the live view still shows them.

**Call detection** (`DictateCore/CallWatch.swift`, `HearthDictate/CallDetector.swift`): every 2 s the app reads Core Audio's process list (`kAudioHardwarePropertyProcessObjectList`, then each process's `IsRunningInput`, `PID`, `BundleID`, macOS 14.2+). Only a fixed list of call apps counts (Zoom, Teams, Slack, FaceTime and `avconferenced`, Webex, Discord, WhatsApp and others; never browsers, which the extension covers), and only one with a Dock icon. `CallWatch` offers "Take notes on this Zoom call?" after 4 s of mic use when nothing records (once per app per 10 minutes); the click opens `/meetings/start?via=mac-call&app=Zoom`, which picks "Any app on this Mac" by itself. When the app lets go for 20 s after a call of a minute or more, and an "Any app" recording that began during the call is running, the app sends `{session, type:'call-ended'}`; the live meeting (not the page) then stops in 30 s unless the member chooses Keep recording. A recording already running when the call began is never stopped. Settings → "Offer to take notes when a call starts" turns it off. `Hearth --call-probe 10` lists every mic user.

### 7.10 Speakers and word lists (`docs/PLAN-meeting-speakers.md`)

- **Word lists.** A session stores `vocabulary` in its meta at creation: each attendee's name and its parts, then the member's and team's Dictate word lists (`Dictation.keyterms`), once each ignoring case, at most 100 (`meetingVocabulary`). The transcriber gets them as Deepgram `keyterm`s, so a recovered session keeps them.
- **Diarization.** The `them` track's Deepgram stream asks for `diarize=true`; `me` never does (the note-taker stays "Me", which Agent briefs and action items rely on), and neither does a dictation (`failOnDrop`). A diarized final is split into one segment per run of the same speaker, labelled `Speaker n` (Deepgram's index + 1); a partial takes its first word's speaker. Labels can restart after a reconnect (Deepgram numbers per connection). Mic-only meetings (one room, one mic) are not diarized.
- **Guesses.** When the transcript still has `Speaker n` labels and the note has attendees, Enhance asks the model for a `Speakers:` line before the body; only guesses naming an attendee (by display name) for a label in the transcript are kept, as frontmatter `speaker_guesses`. The note body keeps the label ("Speaker 2"), never a guessed name.
- **Naming.** `nameSpeakers` renames labels in the transcript lines (`renameSpeakers` in `@hearth/format`, every other byte kept) and, as whole words, on the note's AI lines only (`ai_ranges`), drops the renamed labels from `speaker_guesses`, and moves `models.enhanced_blob` along when the note was unedited, so the next Enhance isn't refused. The transcript panel shows "Who's who?" with Confirm per guess, and every label but "Me" is a button that offers the attendees or a typed name.

### 7.11 Transcript cleanup after the call (`apps/server/src/meetings/cleanup/`, `docs/PLAN-transcript-cleanup.md`)

- **When.** Right after Stop commits a meeting, `TranscriptCleanup` runs in the background, as one job per meeting, registered in the same tick its kept audio becomes pending (so no sweep uploads and deletes the PCM first, and no Enhance finds the note without the job). Enhance (`enhanceNote`'s `transcriptSettled`, wired to `MeetingSessions.cleanupSettled`) waits for that meeting's job before it reads the transcript, at most `CLEANUP_WAIT_MS` (2 minutes); past that the job is aborted, unless it has passed its last check and is committing, in which case Enhance waits for the commit. Either way the transcript never changes under a note enhanced without it. Deleting the meeting and shutdown abort the job. Naming speakers is refused (409) while a job runs, and when the transcript is not the one the panel showed (`transcriptBlobOid`), since a re-transcription can renumber speakers.
- **Kept audio: re-transcribe.** With kept audio and `ASR_PROVIDER=deepgram`, each track's PCM is streamed from the session directory as WAV to Deepgram's pre-recorded API (nova-3, `utterances`, the session's `vocabulary` as keyterms, `diarize` on `them` only), before the kept-audio upload, which deletes the PCM and so waits for the job (`#uploadKeptAudio` skips a meeting whose cleanup is running). Utterances become segments labelled like the live ones ("Me", "Speaker n" or "Them"), and the transcript is rebuilt with `transcriptText` (echo filter included). The body is sent sized (`Content-Length`), streamed from disk; an answer that isn't JSON is a plain `asr_error`, never logged. It is thrown away if either track has fewer than half that track's live words, or if Deepgram fails; the spelling pass runs instead.
- **No kept audio: spelling pass.** One `CLEANUP_MODEL` call gets the session's word list (attendees' names, Dictate word lists) and the numbered transcript lines, and answers JSON `[{line, from, to}]`. A fix is kept only when `from` is on that line, `to` is a word-list entry (written as the list spells it), `from` contains no other entry, and `from` sounds like `to` (`soundsLike`: same letters ignoring case and spaces, edit distance at most 40%); `fixTranscriptWords` in `@hearth/format` replaces whole words in the spoken text only, and refuses any fix with a line break or control character. Word-list entries (attendee names come from other people's calendars) are made one line of plain text in `meetingVocabulary`. No word list, no lines, or over 300,000 characters: no call.
- **Commit.** One commit as the owner, `meetings: clean up transcript of "<title>"`, with `unchanged` on the transcript's saved blob: a rename, edit or delete since the save wins and the cleanup is dropped. Git keeps the live transcript. Any failure is logged and leaves the live transcript; nothing retries after a restart.

### 7.12 Import from Granola (`apps/server/src/meetings/import-granola.ts`, `docs/PLAN-granola-import.md`)

- **Where.** Meetings → "Import from Granola" (`/meetings/import`). The member runs Generate CSV in Granola (Settings → Profile) and drops the `.csv`, or a `.zip` with CSVs in it, on the page. The browser parses it (`granolaExport.ts`: RFC 4180, BOM, header aliases for Granola's column names, zip via the Keep import's `readZipFiles`) and sends batches of at most 100 meetings and about 6 MB of UTF-8 to `POST /api/meetings/import/granola`.
- **What it writes.** Per meeting, the same three files as a recorded one (§7.4), in the member's personal space: the note (`# title`, `## My notes`, `## Summary` with Granola's summary marked as AI text in `ai_ranges` and `models.enhance: granola`, so Enhance can replace it), the raw notes, and the transcript when there is one. The transcript file is always written (empty when the export has none) and `models.enhanced_blob` is always set, so Enhance works on every imported note. Transcript lines labelled `Me:`/`You:`/`Them:` or a name of up to four capitalised words keep their speaker (with `[h:mm:ss]` or `(m:ss)` times when given) when at least half the lines have one; otherwise every line is "Speaker". The page sends the browser's time zone: a time with an offset is that instant, a time or bare date without one is wall time in that zone, and the note is dated and filed in it like a recorded meeting. Impossible dates are skipped. Paths take the first free `-n` suffix. Attendees split on `;` and lines, and on commas only between addresses.
- **Re-runnable.** Frontmatter `imported_from: granola` and `import_ref` (Granola's id, or `h:` + a hash of title and date) mark an imported meeting; one already in the space, or with no usable date or no content, is skipped. The space is reindexed before the refs are read (an earlier batch whose indexing failed), then one commit per batch as the member (`meetings: import "<n> from Granola"`), indexed before the call returns, and batches from one member run one at a time, so overlapping requests can't add a meeting twice.

## 8. Agent access: MCP server and access tokens (platform PRD P1)

Agents (Claude Code, Claude desktop, scripts) reach Hearth as the member who connected them. Nothing here bypasses `spaces.canAccess`: an agent sees exactly what its member sees in the web app, and every write is a commit authored by that member.

### 8.1 Personal access tokens (`apps/server/src/tokens/`)

- A token is `hth_` + 32 random bytes, base64url. It is shown once, at creation. The server keeps only its SHA-256 hash, with `{ id (ULID), name, hint (the last 4 characters), userId, email, memberName, createdAt, lastUsedAt }`, in `DATA_DIR/tokens/tokens.json` (atomic write, like the push store). Not in Git: a credential never goes in a space repo. Not in `index.sqlite`: that file is a disposable cache. Losing the file revokes every token; members make new ones.
- At most 20 tokens per member; a name is 1–80 characters.
- `TokenAuth` wraps the configured `Authenticator`. A request whose `Authorization` header is `Bearer hth_…` is a token request and never reaches Clerk: an unknown or revoked token is unauthenticated (401). A known one becomes the member it was made for, re-checked on every use with `Authenticator.principalForUser(userId)`: in Clerk mode that loads the user (cached 5 minutes, same domain lock), so a deleted Clerk user's tokens stop working within 5 minutes; in dev mode it is the email in the user id. The principal carries `via: { kind: 'token', tokenId, tokenName }`. Every other request goes to the wrapped authenticator unchanged.
- Tokens work on `/api` (that is the "HTTP API" in the PRD) and on `/mcp`, except where they could outlive their own revocation (403): the token routes (a leaked token can't mint more) and push-reminder subscribe/unsubscribe (a subscription is a channel the server keeps sending to). WebSocket handshakes (`/ws`, `/ws/meetings/:id`) refuse tokens: a socket is checked only once.
- A Clerk user who is deleted, banned or locked is gone: `principalForUser` is null, so their tokens stop within the 5-minute user cache.
- `PUT /api/spaces/:space/file` with a token adds `Hearth-Via: api (token "<name>")`. Other HTTP writes with a token (move, delete, conflict resolve, assets, enhance) carry no marker yet; the author is still the member.
- `lastUsedAt` is updated in memory on use and written at most once an hour per token. An unreadable token file refuses every token and every write (it is never replaced with an empty list); a missing one is no tokens.

```
GET    /api/tokens        → [{ id, name, hint, createdAt, lastUsedAt }]   (the caller's own)
POST   /api/tokens        { name } → { id, name, hint, createdAt, lastUsedAt: null, token }   (token shown once)
DELETE /api/tokens/:id    → 204   (404 unless it is the caller's)
```

The web app's **Settings** page (`/settings`, linked from the app rail) lists the member's tokens, creates one (shows it once with a copy button and the `claude mcp add` command filled in), and revokes them.

### 8.2 The MCP endpoint (`apps/server/src/mcp/`)

- `POST /mcp`: MCP over Streamable HTTP (`@modelcontextprotocol/sdk`, `WebStandardStreamableHTTPServerTransport`), **stateless**: each request builds a fresh `McpServer` for its principal and answers with JSON (no SSE, no session id), so a deploy or restart never strands a client. `GET` and `DELETE /mcp` are 405 (no server-initiated stream). It sits behind the same `authenticate` middleware and body limit as `/api`: no principal is 401 `{ error: { code: 'unauthorized' } }`, and the personal space is provisioned on first use.
- A tool that is refused or fails returns an MCP tool error (`isError: true`, text `"<code>: <message>"`), never a transport error. A space the member can't access is `forbidden`; searches and lists silently cover only the member's visible spaces, as the API does.
- Writes go through `saveFile` (the same path as `PUT /api/spaces/:space/file`: ids added, `.hearth/space.yaml` refused, merge or conflict branch on a stale base), authored by the member, with the trailer `Hearth-Via: mcp` (token requests add the token name: `Hearth-Via: mcp (token "<name>")`). `parseCommitMessage` keeps trailers other than the label in the message.

Tools:

| Tool | Input | Output (JSON text) |
| --- | --- | --- |
| `list_spaces` | — | `[{ name, kind, label }]` |
| `search` | `query`, `kind?` (`docs`/`meeting`/`transcript`/`task`/`other`, or a list), `space?`, `prefix?`, `limit?` (1–50, default 20) | `[{ space, path, title, snippet, score }]`, matches marked `**…**` |
| `list_files` | `space`, `dir?`, `recursive?` | entries (one level, as the tree API) or every file under `dir` (at most 2000, `truncated` flag) |
| `read_file` | `space`, `path`, `ref?` | `{ space, path, blobOid, content }`; binary files (a NUL byte, or not valid UTF-8) are refused (use `GET /api/spaces/:space/raw`); text over 500 000 characters is cut, with `truncated: true` |
| `write_file` | `space`, `path`, `content`, `message?`, `base_blob_oid?` | `SaveResult` (`committed` / `merged` with content / `conflict` as a tool error naming the conflict ref) |
| `list_meetings` | `space?`, `from?`, `to?`, `person?`, `company?`, `folder?`, `limit?` (default 50) | `GET /api/meetings` items |
| `get_meeting` | `space`, `path`, `include_transcript?` (default true) | `{ space, path, title, frontmatter, note, transcriptPath, transcript }`; a file that isn't `type: meeting` is `bad_request` |
| `ask_meetings` | `question`, `space?`, `meeting_path?`, `folder?`, `person?`, `company?` | `{ answer, citations: [{ space, path, line, text }] }` (the Meetings chat) |
| `get_agent_brief` | — | `{ generated, basedOn: { meetings, tasks }, brief, corrections }` (§13), or `{ brief: null, message }` when there is nothing to write from; the first call writes it |

More tools (2026-11-12), each in its own module under `apps/server/src/mcp/tools/`:

| Tool | Input | Output |
| --- | --- | --- |
| `move_file` | `space`, `from`, `to`, `to_space?` | Within a space: `GitStore.move` with links into it rewritten and a meeting note's transcript following (the `/move` route's own helpers). Across spaces only personal → team, files only, as Share to team: both targets must be free first (`conflict`, nothing moved), then `moveAcrossSpaces` for the note and its transcript; a failure after the first reports what moved. A transcript follows only when it is a writable file beside the note (`besideNote`, also used by the web routes). `{ space, path, oid }` or `{ space, path, moved }` |
| `delete_file` | `space`, `path` | `moveToTrash`, as `DELETE /file` (transcript follows): `{ space, path, oid, trashed }` |
| `file_history` | `space`, `path?`, `limit?` (default 20, max 200) | `GitStore.log` (`--follow` with a path) |
| `restore_file` | `space`, `path`, `oid` | the `/restore` route's `restore()`; a conflict is a tool error |
| `list_clips` | `query?` (≤ 200), `from?`, `to?`, `mine?`, `limit?` (default 25) | `Clips.list` (`team` scope unless `mine`; dates filtered in SQL): what the Clips page lists, never another member's recording in progress. Metadata, summary and the page URL; no video or signed media URLs |
| `get_clip` | `id` | `Clips.get` plus the transcript as `[m:ss] text` lines |
| `list_events` | `from?`, `to?` (default the next 24 h; at most 62 days, and with the sync on, within its window of 30 days back to 15 ahead, else `bad_request`), `limit?` | `meetings.calendar.upcoming(principal, …)` after a `refresh` (max age 60 s): the caller's own calendar only. Each event carries `note`, the meeting note whose `calendar_event_id` is the event's (`meetingNotesByEvent`, own space first) |
| `get_event` | `id`, `around?` | the same, searched ±1 day around `around` or across the synced window (30 days back, 15 ahead), with `description` |

Move, delete and restore commits carry the `Hearth-Via` trailer: `GitStore.move` and `moveAcrossSpaces` take `{ via }`. The server instructions tell the model how to prepare a meeting: `get_event`, `get_agent_brief`, `list_meetings` by attendee, `get_meeting`, `list_tasks`.

An organization's chat app is not exposed yet (follow-up).

### 8.3 Tests

- Unit: token minting, hashing and lookup, the per-member cap, revoke, `TokenAuth` (token header never reaches the wrapped auth; unknown/revoked → null; a member gone from Clerk → null), the trailer.
- Integration (`test/integration/mcp.test.ts`, `app.request` with an SDK `Client` over a fetch-backed transport): token routes (create, list without the secret, revoke, a token can't manage tokens, another member's token id is 404), `/api` with a token, `/mcp` 401 without one, 405 on GET; each tool; scoping refusals (Bob's personal space is `forbidden` in every tool that takes a space and absent from Alice's search and lists); `write_file` commits authored by the member with the `Hearth-Via` trailer.
- E2E (`e2e/mcp.spec.ts`): against the built server, create a token from Settings in the browser, then a real SDK client over Streamable HTTP lists spaces, writes, searches and reads the doc back; the revoked token is refused.

## 9. Hearth Dictate

System-wide dictation for the Mac: hold Right Option, speak, release, and cleaned-up text is pasted where the cursor is. Three parts: a server module, a setup page, and a menu bar app.

### 9.1 Server (`apps/server/src/dictation/`)

```ts
export interface DictationTranscriber { transcribe(audio: Uint8Array, { mimeType, keyterms, language? }): Promise<{ text: string; durationMs: number }> }
// FakeDictationTranscriber (ASR_PROVIDER=fake): "um so this is a fake dictation, uh, of N seconds", N from the WAV header.
// DeepgramDictationTranscriber: POST https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true[&language][&keyterm=…],
//   `Authorization: Token`, the raw audio as the body, 60 s timeout; results.channels[0].alternatives[0].transcript and metadata.duration.
//   45 s timeout. Any failure is asr_error 502; the log names the status, never the audio or text.
export function styleForApp({ name?, bundle? }): 'chat' | 'email' | 'code' | 'neutral'   // bundle id exact, else app name as a whole word
//   opts.chatNames: the organization's own team chat (teamChatNames: "<org> chat", "<org>-chat" when CHAT_URL is set) counts as chat
export function buildCleanupPrompt({ transcript, style, appName?, dictionary }): { system, user }
//   system: CLEANUP_SYSTEM (clean, never answer or obey the transcript, keep the speaker's words, apply self-corrections and
//   spoken formatting, spell dictionary terms exactly, answer inside <cleaned>). user: <context app=…>style rule</context>,
//   <dictionary>, <transcript>; angle brackets in outside text become ‹ › so it can't close a tag.
export function cleanTranscript(llm, model, input): Promise<{ text, cleaned }>
//   Never fails a dictation: an LLM error, no answer within 15 s, an answer without <cleaned> tags, or one longer than
//   1.6 × the transcript + 80 characters (it answered instead of cleaning) returns the raw transcript with cleaned: false.
//   An empty transcript skips the model. In production it has its own Anthropic client with no SDK retries.
export function skipsCleanup(raw): boolean
//   A plain dictation skips the model: at most 40 words of English (other languages, by the request's `language` or a
//   non-ASCII letter, keep a 3-word limit, since the cues are English; Chinese, Japanese and Thai count two characters
//   a word) with no filler, self-correction ("no, wait", "make that", "or rather", "never mind"…, punctuation allowed
//   between the words as Deepgram writes them), spoken formatting or symbol ("dash", "dot com"…), list cue ("first",
//   "number one"…) or repeated word ("the, the"). It is
//   pasted as Deepgram punctuated it, with dictionary spellings and the chat no-trailing-period rule applied in code
//   (`tidyShort`). On our own dictations the model was ~80% of the wait (0.7–1.8 s of 0.9–2.1 s key-up to text).
// Dictation.speculate(principal, transcript, context) → { transcript, result } | null starts a cleanup before key-up;
//   Dictation.finish(…, speculation) uses it when the final transcript is the same, else cleans afresh. The timing line
//   adds "skipped" and "speculated".
export class DictationStore   // DATA_DIR/dictation.sqlite: its own file, not the index, which may be deleted and rebuilt
//   dictation_devices (id, user_id, email, name, token_hash sha256, created_at, last_used_at, revoked_at); tokens are
//   `hdt_` + 32 random bytes base64url, shown once; at most 20 live devices a member. Devices and personal words are keyed
//   by user id, not email, which can change.
//   dictation_words (scope 'team' | user id, word, position); lists of at most 200 words of at most 60 characters, deduplicated
//   case-insensitively; the team list is seeded with Hotsauce, Clerk, Deepgram, Anthropic, Claude.
export class Dictation { dictate(principal, { audio, mimeType, mode, appName?, appBundle?, language? }): Promise<DictateResult> }
//   30 a minute per member (rate_limited 429); ≤ 15 MB (413); a WAV over 10 minutes is 413 before any paid call. Keyterms are
//   the member's words then the team's (≤ 100). mode=literal skips the model.
```

Config: `DICTATION_MODEL` (default `claude-haiku-5-5`). The transcriber follows `ASR_PROVIDER`, the model `LLM_PROVIDER`.

### 9.2 API (`/api/dictation`)

```
POST   /api/dictation/transcribe?mode=clean|literal&app_name=&app_bundle=&language=   raw audio body (audio/wav, audio/mp4, audio/webm; else 415)
                                     → { text, raw, cleaned, durationMs, ms: { asr, llm } }   Cache-Control: no-store
GET    /api/dictation/words          → { mine: string[], team: string[], account: email }
PUT    /api/dictation/words          { scope: 'mine' | 'team', words } | { scope, add?, remove? } → { scope, words }   (any member edits the team list; add/remove apply to the list as it is now, in one transaction, so concurrent edits keep each other; team edits are logged with who and which device, never the words)
GET    /api/dictation/devices        → [{ id, name, createdAt, lastUsedAt }]   (the caller's live devices)
POST   /api/dictation/devices        { name } → 201 { id, name, createdAt, lastUsedAt, token }   (token shown once)
DELETE /api/dictation/devices/:id    → 204   (own devices only; else 404)
DELETE /api/dictation/devices/self   → 204   (device token only: a Mac disconnecting or replacing itself)
```

```
WS     /ws/dictation                 first message { type: 'start', token: hdt_…, mode, app_name?, app_bundle?, language? } → { type: 'ready' };
                                     then binary 16 kHz mono PCM16 frames while the member speaks; { type: 'finish' } → { type: 'result', ...as /transcribe }
                                     and close 1000; { type: 'cancel' } closes; failures are { type: 'error', code, message } and close 4401 / 4403 / 4429 / 4500
```

The stream (`dictation/socket.ts`) uses the Meetings streaming `Transcriber` (Deepgram nova-3 over a WebSocket, keyterms as vocabulary), holds audio sent before Deepgram is ready (up to 30 s), refuses past 10 minutes, counts against the same 30 a minute, and on `finish` waits for Deepgram's last finals, then runs the same `Dictation.finish` as the upload (`asrMs` is then the wait after key-up, and the timing line says `"via":"stream"`). While the member speaks, 300 ms after Deepgram's latest final words with nothing newer, the stream starts a speculative cleanup of the transcript so far (`Dictation.speculate`); a member who pauses before letting go finds it ready at key-up, and newer words simply replace it. One runs at a time (a pause during one is taken up when it returns) and at most four per dictation. Measured on a Mac against a local server with real Deepgram, key-up to transcript went from 0.6–0.8 s (upload) to 0.1–0.17 s (stream). The Mac opens the stream on key-down and streams converted audio as it records, keeps the recording, and uploads it to `/transcribe` if the stream fails in any way, so streaming can only make a dictation faster.

Device tokens: `Authorization: Bearer hdt_…` is recognised in `authenticate` before Clerk and is accepted for `POST /transcribe`, `GET` and `PUT /words` (the Mac app's Dictionary page) and `DELETE /devices/self` only; any other request carrying one is 401, whatever else it carries. Each use re-checks the member through `Authenticator.principalForUser` (Clerk's user cache and domain lock; dev auth checks the domain): a deleted account is 401 and a refused domain 403, and both revoke all that member's devices. The body limit is 15 MB for `/transcribe`, 12 MB elsewhere. Neither the audio nor the text is logged or stored.

### 9.3 Web (`apps/web/src/apps/dictate/`)

`/dictate` is the third app in the switch. Download for Mac (`/downloads/Hearth.dmg`; the zip stays as a fallback; the image also serves both under their pre-0.3 names, `HearthDictate.*`, for old links), first-install steps for Gatekeeper (Done → Privacy & Security → Open Anyway, with a button to that pane), Connect this Mac (`POST /devices`, then `hearth-dictate://connect?token=…&server=<origin>`, with the same link shown as a code to paste if the app isn't installed), connected Macs with Disconnect, and My words / Team words editors.

### 9.4 Mac app (`apps/dictate-mac/`)

Swift package, macOS 14+, built with the Command Line Tools alone. `DictateCore` is the pure, tested part: `WAV.encode`, `StreamingResampler` (any rate and channel count → 16 kHz mono Int16, box-filtered), `HotkeyStateMachine` (hold to talk; presses under 0.3 s are ignored; a second press within 0.4 s of a short tap is hands-free until pressed again; Esc cancels and is swallowed only while recording; another key while holding is a shortcut, not a dictation), `ConnectLink` (https only, http only for localhost; origin only), `DictationClient`, `PasteboardSnapshot`, `DictationHistory`. `HearthDictate` is the app: a CGEventTap (Accessibility) on flagsChanged/keyDown for Right Option, Right Command or Fn; a new AVAudioEngine per dictation, converted as it records, stopped at 7.5 minutes (under the 15 MB limit); a borderless non-activating panel that is never key or main, shown with `orderFrontRegardless`; on a result, if the app frontmost at key-down is still frontmost and Accessibility is granted, the pasteboard (every item and type) is saved, the text written (marked `org.nspasteboard.TransientType`), ⌘V posted with only the Command flag, and the old pasteboard put back 1 s later (Electron apps read it late) unless something else wrote to it meanwhile; the app's own ⌘V carries a marker in `eventSourceUserData` so its key tap ignores it; a new dictation can't start while the last one is being written up; otherwise the text is left on the clipboard with "Copied — press ⌘V". A retryable failure (network, 5xx, 429) keeps the request in memory for "Retry last dictation"; a 401 forgets the token. The token and its server are kept together in `~/Library/Application Support/HearthDictate/connection.json` (0600, in a 0700 folder), so the server can't be changed without connecting again. Not the Keychain: a self-signed app's legacy Keychain items are bound to each build's code hash, so every update asked for the login password; the token is scoped to dictation and word lists and revocable on /dictate. A 0.1.x Keychain item is read with Keychain interaction turned off (never a prompt) until a connection file exists: if it can be read it moves to the file, otherwise the member connects again; either way the old item is then deleted, also with interaction off. Connecting first asks Hearth whose token it is (`GET /words` → `account`); a link (any web page can open one), another server, or replacing a connection asks the member, naming the account; a replaced connection and Disconnect revoke themselves (`DELETE /devices/self`). If macOS turns the key tap off, it is turned back on and a release missed meanwhile is caught up from the current modifier flags. History (text, cleaned or not, app, time, audio length, word count, timings; never audio) is kept on this Mac only, in `~/Library/Application Support/HearthDictate/history.json` (0600, in a 0700 folder, written off the main thread via a private temp file after the paste; a file it can't read is set aside, not overwritten), pruned past the member's retention (7, 30 or 90 days, default 30) at launch and every six hours, and never uploaded.

The main window (`MainWindow.swift`, SwiftUI `NavigationSplitView` in Hearth's colours) opens when the member launches the app (not as a login item), on reopen once set up, and from the menu: Dictations (7 days / 30 days / all: total words; time saved = words ÷ 40 wpm − speaking time, never negative; words per minute of speech; top apps with their icons; the month's activity grid; recent dictations, searchable, with Copy and Paste), Dictionary (both word lists over `GET`/`PUT /words`), Settings (open at login, meeting reminders, the suite's server; hotkey, mode, live permission rows, account and Disconnect, history retention and Clear). Since 0.2.0 it opens from ⌘, (Settings) and the app menu's Dictate…, not at launch. The Command Line Tools' SwiftUI has no `@State` (its macro plugin ships with Xcode), so view state lives on the model. `HearthDictate --render-previews <folder> [--dark]` draws each page with made-up history held in memory, for checking the design without screen access.

`scripts/build-app.sh` builds a universal binary, writes Info.plist (`dev.hotsauce.dictate`, the name from `Brand.swift`, the microphone and camera strings, the `hearth-dictate` and `hearth` URL schemes; the camera entitlement), signs it, and writes `release/Hotsauce.dmg` (the app beside an Applications link) and `release/Hotsauce.zip` (git-ignored); put them in `release/` before building the image and the Linux Docker build copies them to `/downloads/`. Signing, in order: a Developer ID identity (hardened runtime, timestamp); `Hotsauce Local Code Signing`, a self-signed identity that `scripts/create-signing-identity.sh` creates once in the build Mac's login keychain (hardened runtime), so every build has the same designated requirement and macOS keeps Microphone and Accessibility across updates; else ad hoc, which changes with every build and makes members grant Accessibility again. Recreating the identity (a new build Mac) is running that script again; members then re-grant once. With a Developer ID identity and the `mac-notary` notarytool keychain profile (`xcrun notarytool store-credentials mac-notary`, the app-specific password stays in the keychain), the script notarizes the zipped app and staples it, rebuilds the zip, then signs, notarizes and staples the DMG; with a Developer ID but no profile it warns that the build is not notarized. The DMG window (background, icon positions, 128 px icons) is written by dmgbuild (`uvx dmgbuild==1.6.7`, MIT) from `Resources/dmg/settings.py` and `background.tiff`, which `scripts/render-dmg-background.mjs` renders at 1x and 2x from `background.html`; without uv the script falls back to a plain window.

Opening the app while it runs (`applicationShouldHandleReopen`) shows the suite window. The setup window opens at launch until it has been closed once; it says what's missing in one line (microphone, Accessibility, the key tap, the connection) and names the connected account. The menu bar icon has a fixed autosave name (`HearthDictate`), starts near the right edge beside Control Center (`NSStatusItem Preferred Position HearthDictate` = 120 when unset) instead of the left end where a MacBook's notch hides new icons, can't be dragged out, and follows a Show in menu bar setting; when it is on but not on screen (occluded, off-screen, or not allowed in System Settings → Menu Bar) Settings and the setup window say so and link to the Menu Bar settings. Every 2 s the app re-checks the permissions, restarts or re-enables the key tap, updates the menu bar icon, and writes what it sees to `status.*` in its defaults (including `status.menuBarIconShown`) (`defaults read dev.hotsauce.dictate`) for diagnosis. If Accessibility is on but the tap still can't start, the window offers Quit and reopen. `Hearth.app/Contents/MacOS/Hearth --transcribe-file <path> [--literal] [--app-name N] [--app-bundle B] [--server URL]` runs the same upload with `HEARTH_DICTATE_TOKEN` (never the saved connection) and prints the JSON, for end-to-end tests.

### 9.4.1 The suite window (0.2.0, plan `docs/plans/2026-11-11-mac-app.md`)

The app is a Dock app (`.regular`, no LSUIElement) whose main window (`SuiteWindow.swift`) is the whole web suite in a `WKWebView`: the default persistent `WKWebsiteDataStore`, so the Clerk session survives relaunch; `applicationNameForUserAgent` Safari's version string, so the user agent is exactly Safari's and Google's sign-in page accepts it. Closing the window hides it: the page keeps its session, a recording, and the reminders' calls. `SuiteRouter` (`DictateCore`, tested) decides each navigation: the server's origin stays in the window; a page elsewhere, clicked or not, goes to the default browser (iframes load where they are); mailto/tel go to their apps on a click; the app's own schemes (`hearth-dictate://connect` from the Dictate page, `hearth://`) come back to the app; every other scheme (`file:`, other apps') is refused. Sign-in hosts (`accounts.google.com`, `clerk.`/`accounts.` + the server's host, `*.clerk.accounts.dev`, `clerk.com`) never load in the window: they start the browser sign-in below. A new window on the suite loads in the main window. Downloads: a response WebKit can't show or marked `attachment` becomes a `WKDownload` to `~/Downloads` (`DownloadName.unique`, `name 2.ext`, never outside the folder); a click on `a[download]` with an http(s) href is caught by a user script and downloaded natively, because WebKit ignores the attribute on another origin's link (a clip's presigned storage URL). Uploads use the open panel; `alert`/`confirm`/`prompt` are sheets; camera and microphone requests from the server's origin are granted (macOS asks once per app; the camera entitlement and usage string are in the bundle), others are prompted. Menus: App (Settings… ⌘,, Dictate…), File (Close ⌘W), Edit, View (Reload ⌘R, zoom, full screen), Go (Back ⌘[, Forward ⌘], Home ⇧⌘H, the rail's apps on ⌘1–⌘5 from `Brand.railShortcuts`), Window. Opening a path while the page is on the suite uses `history.pushState` + `popstate`, so React Router changes route without reloading (an open recording survives); otherwise it loads the URL. A failed load shows a small page with Try again.

Sign-in through the browser (Google refuses to sign in inside an app's web view): in the app, the web sign-in page sees the `hearthSignIn` script bridge and shows "Sign in with your browser" instead of Google. The app makes a random 32-byte state (`DictateCore/BrowserSignIn`) and opens `<server>/desktop/connect?state=…` in the default browser. That page (signed out → `/sign-in`, which now returns to where it was going) asks "Sign in to Hearth on this Mac as <email>?"; only on that click does it call `POST /api/desktop/ticket`, which needs a signed-in session (`sessionOnly`: never an access token; device tokens never reach it) and returns a Clerk sign-in token for that member, single use, 60 s (`signInTokens.createSignInToken`; dev auth's ticket is `dev:<email>`), `Cache-Control: no-store`. The page opens `hearth://auth/callback?state=…&ticket=…`; the app accepts it only if the state is the one it started in the last 10 minutes (a link from anywhere else gets an alert), then opens `<server>/desktop/finish`, which asks the app for the ticket over a reply bridge (`hearthTicket`: suite origin, main frame, that path only, once, within 60 s) and redeems it with `signIn.create({ strategy: 'ticket' })` + `setActive`, then opens Docs. The ticket is never in a URL, so a link to the finish page (a doc, another site) signs nothing in, and deep links and shortcuts refuse `/desktop/*` paths. Residual: another local app that registers `hearth://` could receive a callback and redeem its ticket within 60 s; that needs malware already on the Mac, so the state check is the only binding (no PKCE). The window's own Clerk session then persists like any other.

Deep links: `hearth://<path>` (scheme from `Brand.urlScheme`) and `hearth-dictate://open?path=/x` open that path, only ever on the configured server (`SuiteRouter.url(forPath:)` refuses full URLs and `//host`). The server is Settings' value, else the server Dictate is connected to, else office.example.com.

Meeting reminders (`Reminders.swift`, rule in `DictateCore.ReminderPlanner`): every 30 s, `GET /api/calendar/upcoming` for the next 5 minutes, run as `fetch` inside the signed-in page (`callAsyncJavaScript` in the page world, only while the page is on the suite's origin) with `window.Clerk.session.getToken()` as a bearer, else dev auth's `hearth.devUser` header, plus the session cookie. A meeting with attendees starting within 90 s gets a notification once per event and start time (the web push rule), "Take notes for “<title>”?"; clicking it opens `/meetings/start?event=<id>` in the window. No server change; a member who also turned on web push reminders in a browser gets both. Off in Settings. `status.remindersLastStatus`, `status.remindersLastChecked`, `status.remindersLastPosted` and `status.notificationAuthorization` are written to the app's defaults for diagnosis.

Brand: `DictateCore/Brand.swift` holds the display name (`Hearth`), accent, URL scheme and rail shortcuts; the build script reads the name and scheme from it. The server has no brand endpoint. Strings that existed before 0.2.0 ("Hearth Dictate" for the dictation feature) are unchanged, except where they name the app in System Settings.

`Hearth --self-test <server> <folder> [--sign-in-dev <email>] [--remind] [--try-google]` drives the real suite window (shown on screen, since WebKit doesn't paint a hidden one) and writes `result.json` and PNG snapshots: storage and a cookie left by the previous run, an in-place route change, the reminders' API call and planner, Start opened from a reminder, a deep link, the media APIs the page sees, and Google's sign-in page. Run it from the installed app, with the app quit.

**Name and icons (0.3.0):** the bundle is `<Brand.name>.app` ("Hearth.app") with executable `Hearth`; the bundle id and signing identity are unchanged, so the designated requirement (`identifier "dev.hotsauce.dictate" and certificate root = …`) and with it Microphone and Accessibility carry over the rename. On launch from an Applications folder, an old `HearthDictate.app` with the same bundle id goes to the Trash (it would otherwise still show in Spotlight and could answer `hearth://` links), and Open at login is registered again when the app's path changed. Internal names stay: the data folder `~/Library/Application Support/HearthDictate`, the menu bar autosave name, the SwiftPM product. The app icon and the menu bar icon are the Hotsauce bottle from `apps/web/public/favicon.svg`, drawn in `ProductMark.swift` (the app icon on a cream tile; in the menu bar a silhouette with the label cut out); `Hotsauce --render-app-icon <dir>/AppIcon.iconset` writes the iconset for `Resources/AppIcon.icns` (`iconutil -c icns`). In the menu bar the bottle is a template image: dimmed until Dictate is connected and listening, ember while it records, orange while it writes up, a warning triangle on an error.

### 9.5 Tests

Server unit: WAV reading, Deepgram response mapping from `test/fixtures/deepgram/prerecorded.json` and the request it sends, the prompt builder (fencing, style rules), app-style mapping, the cleaner's fallbacks, token format, hashing and store, the rate limiter. Server integration (`test/integration/dictation.test.ts`): a WAV through the route with fakes, literal mode, LLM failure, no transcript in any log, content types and limits, 30/min, device tokens refused on every other route, revocation, domain lock, deleted accounts, word lists. Web: the page against MSW. E2E (`e2e/dictate.spec.ts`): connect, dictate with the token as the Mac would, add a word, disconnect, refused after. Mac: `swift test` (Swift Testing, including `SuiteRouter`, `DownloadName`, `UpcomingMeeting` decoding and `ReminderPlanner`; XCTest isn't in the Command Line Tools). If `swift test` reports "plugin for module 'TestingMacros' not found" right after an edit, run it again: a toolchain flake.

## 10. Hearth Clips

An internal async screen recorder: record the screen with the camera in a bubble (or either alone), send the link, and whoever watches gets a transcript and speed control. Plan and the decisions behind it: `docs/plans/2026-11-10-clips.md`. Clips are not in Git: video and thumbnail go to the kept-audio store, metadata to its own SQLite file.

### 10.1 Server (`apps/server/src/clips/`)

```ts
export class ClipStore            // DATA_DIR/clips.sqlite (its own file, like Dictate's): one `clips` row per clip — owner (user id, email,
                                  // name), title, title_set (the owner chose it), summary, mode, container (mp4|webm), status
                                  // (recording|processing|ready|failed), error, duration/size/width/height, has_thumb, transcript_status
                                  // (pending|processing|ready|failed|none), transcript (JSON [{start,end,text}], seconds) and its text for search
export interface ClipTranscriber { transcribe(audio, { mimeType, keyterms, durationMs }): Promise<TranscriptSegment[]> }
// FakeClipTranscriber (ASR_PROVIDER=fake): "clip segment n" every 2 s of the clip. Production refuses the fake (config).
// DeepgramClipTranscriber: POST /v1/listen?model=nova-3&smart_format&punctuate&paragraphs&utterances[&keyterm=…], 10 min timeout;
//   one line per paragraph sentence, else per utterance, else the whole transcript at 0:00. Failures are asr_error; the log names the
//   status, never the words.
export class Clips {
  create(principal, { mode, container, title? })     // at most 3 open recordings a member
  putChunk(principal, id, seq, bytes)                 // owner only, while recording; DATA_DIR/clips/uploads/<id>/<seq>.part, written to a
                                                      // temp file and renamed, so a resend replaces it; ≤ 2 GB a clip
  finish(principal, id, chunks)                       // 409 naming missing chunks; again once finished returns the clip as it is
  rename / delete / retryTranscript (owner only), get / list (any member; another member's recording in progress is 404 and unlisted)
  recover()                                           // startup: re-runs clips left processing and transcripts left pending; hourly sweep
}
```

Processing, one clip at a time: concatenate the chunks in order; `ffmpeg -fflags +genpts -i raw -map 0 -c copy` into WebM (cues and a duration, which MediaRecorder leaves out) or MP4 with `+faststart`; `ffprobe` for duration and size; a 640 px JPEG from a second in; both into the store at `clips/<id>/video.<ext>` and `clips/<id>/thumb.jpg`; status `ready`; the chunks are removed. Transcripts run on a second queue so a slow one never holds up the next video: the sound as 16 kHz mono FLAC to the transcriber with the owner's and the team's Dictate words as keyterms (≤ 100); then `CLIPS_MODEL` (default `claude-haiku-5-5`) gets the `[m:ss] text` lines in `<clip_transcript>` and answers `<title>` (only used while the owner hasn't set one) and `<summary>`; a failure there is logged and skipped. A clip without sound is transcript `none`; one ffmpeg can't read is `failed` and its chunks go. Deleting removes the row, the folders and both objects; a clip deleted mid-processing has what was just stored removed too. The sweep removes recordings without a chunk or Stop for 24 hours and any upload or work folder whose clip is gone or failed. Config: `CLIPS_MODEL`, `FFMPEG_PATH`, `FFPROBE_PATH` (default `ffmpeg`, `ffprobe`; the Docker image installs Debian's ffmpeg). `AudioStore` gained `delete(key)`; `R2AudioStore.presignGet(key, { windowSeconds, download? })`; `LocalAudioStore.pathOf(key)`. Clips are offered only when `AUDIO_STORE` isn't `none`. Creating a clip or storing a chunk is refused (409) while the data volume has under 1 GB free, so git and SQLite keep room.

### 10.2 API (`/api/clips`)

```
GET    /api/clips/config                    → { available }
GET    /api/clips?scope=mine|team&q=&limit= → { clips: ClipView[] }      (newest first; q matches title, summary or transcript)
POST   /api/clips                           { mode: screen_camera|screen|camera, container: mp4|webm, title? } → 201 ClipView (status recording)
GET    /api/clips/:id                       → { clip: ClipView, transcript: [{ start, end, text }] }
PATCH  /api/clips/:id                       { title } → ClipView                       (owner)
DELETE /api/clips/:id                       → 204                                       (owner; also how a recording is cancelled)
PUT    /api/clips/:id/chunks/:seq           raw bytes → 204                             (owner, while recording; 12 MB body limit)
POST   /api/clips/:id/finish                { chunks } → ClipView (status processing)   (owner)
POST   /api/clips/:id/transcript/retry      → ClipView                                  (owner, after a failed transcript)
GET    /api/clips/media/:id/video|thumb?exp=&sig=[&download=]   local store only: no session; HMAC-signed (per-process key), Range → 206
```

`ClipView` carries `videoUrl`, `thumbUrl` and `downloadUrl` once ready: with R2, presigned GETs signed at the start of a 3-hour window and valid for two (stable within a window, so cacheable), the download with `response-content-disposition`; the browser streams and seeks from R2 and nothing passes through the Fly machine. With the local store, the signed route above; its prefix is the only public path besides health and webhooks.

### 10.3 Web (`apps/web/src/apps/clips/`)

`/clips` (library: My clips / Team, search, thumbnails), `/clips/new` (recorder), `/clips/:id` (clip page). Clips is the fourth manifest in `apps/registry.ts` (rail icon `video`, preload `ClipsLibrary`), with its own sidebar (`ClipsSidebar`).

Recorder (`recorder/session.ts`, React-free; `RecordClip.tsx`; `recorder/Bubble.tsx`): Start asks for the share picker (`getDisplayMedia`, entire screen preferred, system/tab audio offered) and then, in the same task, a Document Picture-in-Picture window (Chrome 116+; Chrome doesn't need activation for the first, the second consumes it); the window holds the round camera and the controls (timer, pause/resume, Stop, Discard on a second click) on its own React root and its own timer, and floats over every app, so recording the entire screen captures it. Sharing one window or tab says the bubble won't be in the video; without Document PiP the bubble is drawn in the page. No canvas compositing: a background tab's timers are throttled. 3-2-1 countdown; `MediaRecorder` with MP4 (H.264/AAC) when the browser offers it, else WebM, 2.5 Mbit/s, `timeslice` 3 s; mic and share audio mixed with WebAudio. Each chunk is `PUT` as it's made, one at a time in order, retried with backoff to 15 s through network errors, 408, 429 and 5xx; other refusals stop the upload. Stop (page, bubble, or Chrome's Stop sharing) waits for the last chunk, then `finish` (retried), then opens the clip. A save that can't succeed (nothing recorded, the server refused) discards the clip and says why; a network failure offers Try again or Discard. Pause, Restart (same choices), Discard. 60-minute cap. Leaving the page while recording asks first (router blocker and `beforeunload`); leaving while saving lets the save finish.

Clip page: native `<video controls>` with speed buttons 0.5×, 1×, 1.2×, 1.5×, 1.75×, 2×, 2.5× (remembered in `localStorage` `hearth.clips.speed`); keys Space/k play-pause, ←/→ 5 s, j/l 10 s, `<`/`>` speed. Transcript panel: lines with timestamps, the playing line highlighted and kept in view, a click seeks and plays; processing/failed (owner retries)/no sound states. Title (owner renames inline), summary, Copy link, Download, Delete (owner, confirmed). Polls while processing or transcribing.

### 10.4 Tests

Server unit: store (patches, listing rules, reopen), Deepgram URL and mapping, the fake, `parseRange`, R2 presign (window stability, download disposition). Server integration (`test/integration/clips.test.ts`, real ffmpeg on generated WebM and fragmented MP4 split into chunks): assembly to a seekable WebM and a faststart MP4, out-of-order and repeated chunks, missing chunks, no sound, a broken recording, owner-chosen titles, transcript failure and retry from the stored video, every owner-only route as another member, 401 without a session and 403 outside the domain, listing and search (wildcards literal), signed range playback and tampered URLs, delete and cancel removing files, the open-recording cap, the sweep, restart recovery. Web: uploader (order, backoff, fatal, stop), session (order of picker and bubble, countdown, pause timing, stop, Stop sharing, camera mode, cancel/restart, finish failures), format and speed helpers. E2E (`e2e/clips.spec.ts`, fake camera, mic and screen): screen and camera with the bubble window opening, pause/resume, Stop from the bubble, the clip plays and seeks with a correct duration, speed buttons, keys and memory, transcript click-to-seek and highlight, suggested title and summary, rename, library search, another member can't delete, owner deletes; camera only with Discard then Stop. `e2e/clips-mobile.spec.ts` (Pixel 7): the clip page fits, speed and transcript work. CI installs ffmpeg for the integration and e2e jobs.

### 10.5 v2: the camera as its own track, status, speakers, notes (2026-11-11)

Why: in v1 the camera reached the video only if the screen share captured the floating Document PiP window. It doesn't when one window or tab is shared, and on a Mac Chrome leaves its own PiP window out of an entire-screen capture too, so the face was missing from the first real clips.

- **Recording.** In screen and camera mode a second `MediaRecorder` records the camera's video alone (`video/mp4;codecs=avc1` or WebM VP9/VP8, 1 Mbit/s, 3 s slices), uploaded beside the screen as `PUT /api/clips/:id/chunks/:seq?track=camera` (same 2 GB budget per clip). Both recorders start in the same task, pause, resume and stop together; their `start` events give `camera.offsetMs`. `POST /finish` takes `{ chunks, camera?: { chunks, container, offsetMs }, screenSurface?, screenLabel? }`; a camera whose upload the server refused is left out rather than failing the clip.
- **Compositing.** When the screen video is ready (and playable), a third queue, independent of assembly and transcripts, remuxes the camera, keeps it at `clips/<id>/camera.<ext>` (so the bubble could later be moved or hidden), and runs `composite()` (`clips/media.ts`): the screen scaled to at most 1080 p; the camera cropped square into a circle 24% of the height across, 3.5% in from the bottom left, with a paper-coloured ring (mask and ring drawn once as PNGs, then `alphamerge` and `overlay`, `eof_action=pass` so the screen carries on if the camera ends early; `-itsoffset` when the camera started later, `-ss` when earlier); libx264 `veryfast` CRF 26, AAC, `+faststart`, one thread, a 10-frame lookahead, at nice 19 (the web server, Meetings' sockets and Dictate always come first), timeout 8× the clip's length; composites run one at a time on their own queue, and one queued or running at a restart is made after it. The clip then plays `clips/<id>/composite.mp4` and its thumbnail is redrawn from it; `compositeStatus` is `pending|processing|ready|failed` (`none` without a camera track). A failure leaves the screen video. Restarts resume it (`compositesInterrupted`). Measured on a 5-minute, full-motion 1080p test pattern: 150 CPU-seconds and about 220 MB on an M4 (720 p: 90 CPU-s); on one shared Fly vCPU expect roughly 0.3–0.6× real time for busy video and much faster for mostly still screens, so an hour can take an hour or two: the screen-only video plays meanwhile.
- **Status.** The floating window (280×430, or 280×270 without the camera) and the page show a status panel: a red pulsing Recording light and timer, what's shared (`describeShare`: Entire screen / A window: <title> / A Chrome tab: <title> from `displaySurface` and the track label), the mic's and camera's names (track labels without USB ids), a mic meter drawn on the floating window's own frames, "No sound from this mic for 5 seconds" below a peak of 0.02, and a warning while the shared track is muted (a minimised window).
- **Speakers.** Deepgram `diarize=true`; each segment carries `speaker` (0, 1, …). `ClipView.speakers` is `[{ id, name, named }]`: the owner's name for a speaker, else the recorder's name when only one person speaks, else "Speaker n". `PATCH /api/clips/:id { speakers: { "1": "Bob" } }` (owner; an empty name resets). The prompts read `[m:ss] Name: text`.
- **Notes.** `POST /api/clips/:id/ai { kind: summary | actions }` (any member who can watch; needs a transcript) asks `CLIPS_MODEL` and keeps `aiSummary` (Markdown, images stripped) or `aiActions` (only `- [ ] …` lines; empty when none). `POST /api/clips/:id/send { to: doc | meeting, transcript }` writes into the member's personal space (else the team's), authored by them: a doc at `docs/clips/<slug>.md`, or a Meetings note at `meetings/YYYY/MM/<date>-<slug>.md` with `type: meeting` (its unticked items show on Meetings home) and, with the transcript, a sibling `.transcript.md` in Meetings' own format in the same commit. Title, link to the clip, summary, action items; `clip:` in the frontmatter links back. An existing path gets `-2`, `-3`.
- **Tests.** Server integration: the camera track composited (a blue camera's pixels inside the bubble, the screen's outside, none before the camera's late start), a broken camera leaving the screen video, missing camera chunks, recovery mid-composite, speakers (defaults, rename, reset, refusals, prompt names), summary and action items (and stripping), send to a doc and to a meeting note with its transcript file and Meetings home action items. Web: session with two tracks (pause together, no camera track without a format or in screen mode, a refused camera upload, muted screen), `describeShare`, `deviceName`. E2E: the floating window's status and moving mic meter, the composite's bubble ring found by pixel in the output video, speaker rename, Summarize, Action items, Send to a new doc.

## 11. Organizations: setup, brand kit, bring-your-own keys (Hotsauce)

One instance serves one organization. Everything an organization chooses lives under `<DATA_DIR>/org/` on the volume, and the real environment always wins over it, so an instance configured entirely by env behaves exactly as before.

| File | What |
|---|---|
| `settings.json` | `OrgSettingsSchema` (`apps/server/src/org/store.ts`): org and product names, allowed domains, admins, Clerk publishable key, host kind and GitHub org, R2 bucket settings, chat link, wizard progress, `setupComplete`. |
| `secrets.json` | The six secrets in `SECRET_NAMES`, each sealed with AES-256-GCM under `sha256(HOTSAUCE_MASTER_KEY)`, or under a generated `master.key` beside it when that env var is unset. Mode 0600. Never returned by any API: only `{set, last4, source}`. |
| `brand.json`, `assets/` | The brand kit (`org/brand.ts`) and its logo and icon. |
| `setup-token` | The one-time setup token. |

`main.ts` builds the `OrgStore` first and calls `loadConfig({...org.toEnv(), HOTSAUCE_SETUP_PENDING, ...process.env})`. `toEnv()` is empty until the wizard finishes, so a half-entered key can't end setup mode early.

### 11.1 Setup mode and the wizard

`AUTH_MODE` resolves to `setup` when it is `clerk`, there is no `CLERK_SECRET_KEY` from either source, and setup isn't complete. In setup mode no request can authenticate, `/api/health` says `setupRequired`, and the server prints `${PUBLIC_URL}/setup#token=…` at startup. `/api/setup/*` (state, settings, brand, assets, test, finish) requires setup mode and the token in `x-setup-token` (constant-time compare). The web app sends every path to `/setup` (`AuthRoot`); the wizard keeps the token in `sessionStorage`, strips it from the URL, saves each step as it goes (`stepsDone`) and resumes at the first unfinished step. `POST /api/setup/finish` checks `missingForFinish` (names, domains, admins inside those domains, both Clerk keys, complete GitHub and R2 settings), generates `WEBHOOK_SECRET` for GitHub, sets `setupComplete`, and restarts.

**Restart.** `restart()` is a graceful shutdown that exits with code 75. `scripts/docker-entrypoint.sh` starts the server again on 75 and passes SIGTERM through, so this works the same on Fly, Docker Compose and in e2e. Any other exit code ends the container.

### 11.2 Settings → Organization

`/settings/organization`, admins only (`isAdmin`; access tokens refused), runs the same section components over `/api/admin/org/*`. Brand changes apply at once; settings and keys apply on `POST /api/admin/org/apply` (restart). Fields set by env show as locked. The first admin save on an env-configured instance marks it `setupComplete`.

**Testing keys.** `POST …/test/:provider` makes one read-only call each (`org/test-keys.ts`): Anthropic `GET /v1/models`, Deepgram `GET /v1/projects`, Clerk `GET /v1/users?limit=1` plus a check that both keys are from the same instance, GitHub `GET /orgs/{org}`. Ten-second timeout, plain-language answers.

**Missing keys.** In production a provider without a key is `none`: `Unconfigured*` implementations throw `not_configured` (503) with a message pointing to Settings → Organization, and `/api/health` reports `features.ai` and `features.transcription`. Fakes stay refused in production.

### 11.3 Brand kit

`GET /api/org/brand` (public, so the sign-in page is branded) returns colors, neutral, font pair (`FONT_CHOICES`, all Google Fonts), default theme, logo and icon URLs and the writing voice. `GET /api/org/assets/{logo|mark}` serves SVG/PNG/JPEG/WebP up to 1 MB with `Content-Security-Policy: sandbox` and `nosniff`. The web app's root loader (`brand/boot.ts`) applies it with `applyBrand`: a `<style>` that sets `--brand-primary`/`--brand-accent` and points `--ember`, `--ember-strong`, `--ember-wash`, `--glow`, `--focus-ring`, the paper and ink tokens (for cool or gray neutrals) and `--type-display`/`--type-ui` at it, in light and dark. The default brand emits nothing. Agents read it with the MCP tool `get_brand`. The product name comes from `/api/health` (`brand/product.ts`, cached in `localStorage`); the server rewrites `manifest.webmanifest` with it.

### 11.4 Running on Cloudflare (Hotsauce)

Plan and requirements: `docs/PLAN-cloudflare-deploy.md`. The Worker in `apps/cloudflare/` (root `wrangler.jsonc`) runs the unchanged Docker image as one Cloudflare Container (`HotsauceServer`, a Durable Object named `main`) and passes every request, WebSockets included, to it. It remembers the first visit's origin and gives the container `PUBLIC_URL`, `HOTSAUCE_PLATFORM=cloudflare` and `STATE_URL=http://state.hotsauce`, plus every uppercase string variable or secret of the Worker. Always on: `onActivityExpired` renews unless `HOTSAUCE_SLEEP` is true, and a `*/5` cron starts it again after a crash.

**State mirror** (`apps/server/src/state/`). The container's disk is wiped on every restart. With `STATE_URL` set, `main.ts` restores every stored file under `DATA_DIR` before any store opens (a local file wins), then pushes changes every `STATE_SYNC_MS` (15 s) and on shutdown, including the exit-75 restart. The store speaks four routes (`GET /list`, `GET|PUT|DELETE /o/<key>`); on Cloudflare the container's requests to `state.hotsauce` are answered by the Worker's outbound intercept from the R2 binding under `state/`, so no keys live in the container. Mirrored: everything except what rebuilds or is temporary (`repos/`, `index.sqlite`, WAL/SHM, `*.tmp`, Clips and Files uploads in progress, Clips work, kept audio and local Files bytes, PCM under `sessions/`). SQLite files are copied with the backup API. A new feature's files are covered without changes as long as they live under `DATA_DIR`.

`HOTSAUCE_SETUP_TOKEN` (12+ characters) replaces the generated setup token, so the Deploy button can ask for it. Without `VAPID_*`, push keys are generated once into `DATA_DIR/push/vapid.json`. With `HOTSAUCE_PLATFORM=cloudflare`, the wizard hides "On this server" storage and finishing requires GitHub repos and R2 media.

**Updates.** `HOTSAUCE_VERSION` names the release a copy has; `scripts/update-hotsauce.mjs` (run weekly by `.github/workflows/update-hotsauce.yml`) three-way applies the diff between that tag and the newest upstream tag on a branch and opens a PR, or an issue on conflict. `deploy-fly.yml` deploys main when `vars.FLY_APP` is set. Both skip Hotsauce's own repo.

## 12. Hearth Tasks

A Todoist-style task list for the team. It is built inside the suite (not to sync with Todoist), with a one-time import from Todoist, Ramble-style voice capture, and the open action items from meetings shown alongside. Git is truth: **one task is one Markdown file**, so tasks are searchable, readable by agents, versioned, and survive a reindex. The pure parts (file format, quick-add parser, recurrence, dates) are in `@hearth/format` (`packages/format/src/tasks.ts`), shared by the server and the web app; read that file, it is part of this contract.

### 12.1 The file

`tasks/<ID>.md` (ULID, `taskPath(id)`), in the team space (visible to every member) or the member's personal space (only them). Frontmatter is `TaskFrontmatter`; the body is the task's notes (Markdown, may be empty). Written with `newTaskFile()` and changed only with `patchFrontmatter()` (never re-serialized), so hand edits survive.

```yaml
id: 01J...            # ULID, same as the file name
type: task
title: Call Sam       # one line
status: open          # open | done
priority: 1           # 1 (p1, most urgent) .. 3; absent = 4 (none)
due: 2026-11-13T15:00 # YYYY-MM-DD, or YYYY-MM-DDTHH:mm wall time in `tz`
tz: America/New_York  # only with a timed due
recur: every friday   # normalized rule (normalizeRecurrence); the due date moves on completion
project: Ops          # free text; a project is the set of tasks naming it, per space
labels: [calls]
assignee: alex@acme.example   # lowercase email; absent = unassigned
created: 2026-11-11T12:00:00Z
created_by: ada@acme.example
completed: 2026-11-12T09:00:00Z  # when status is done
completed_by: ada@acme.example
order: 1700          # manual order within a list, lower first; absent sorts after, by created
source: { kind: meeting, space: team, path: meetings/2026/11/....md, line: 14, text: "Send deck" }
        # kind: manual | meeting | voice | import | mcp; import adds from: todoist, ref: <todoist id>
```

Rules:
- A task assigned to anyone but its creator lives in the team space (a personal space is invisible to others); the API refuses (`bad_request`) an assignee other than the caller on a personal task.
- **Mine** = in my personal space, or in the team space with `assignee` = me, or in the team space unassigned with `created_by` = me.
- Completing a recurring task doesn't close it: `due` moves to `nextDue(recur, due, today)` (today in the request's `tz`), the time of day kept, and the commit records the completion (`tasks: complete "<title>"`). Completing a non-recurring one sets `status: done`, `completed`, `completed_by`. Reopen clears those two keys.
- Index: `kindOf()` returns `task` for any `.md` under `tasks/` (a new `FileKind`), via a migration that sets `kind = 'task'` for `tasks/%` and forgets sync points. Task lists come from `Index.listFiles({ space, kind: 'task' })` frontmatter; no git reads to list. Full-text search sees title and notes (`kinds` filter `task`).
- Commit messages: `tasks: create|edit|complete|reopen|delete|move "<title>"`, `tasks: import <n> from Todoist`. Authored by the member; MCP adds `Hearth-Via` like other writes.
- Every write is read → `patchFrontmatter` → `git.commit` with `unchanged: { path, blobOid }`, retried up to 3 times by re-reading and re-applying the same field patch on `conflict` (like `completeActionItem`), so two members editing different fields never lose each other's change and there are no conflict branches for tasks. A file missing at HEAD fails the `unchanged` guard too (`GitStore.commit`), so a stale write never brings back a task deleted or moved meanwhile: the retry's re-read answers 404 `not_found`. A client may send `baseBlobOid` only to be told (409) that the title or notes it is overwriting changed; field patches don't need it.

### 12.2 Server (`apps/server/src/tasks/`)

```ts
export interface TaskView {
  space: string; path: string; id: string; blobOid: string
  title: string; notes: string; status: 'open' | 'done'
  priority: 1 | 2 | 3 | 4; due: string | null; tz: string | null
  dueAt: string | null      // ISO instant of a timed due (dueInstant), else null
  recur: string | null; project: string | null; labels: string[]
  assignee: string | null; createdBy: string; created: string
  completed: string | null; completedBy: string | null
  order: number | null; source: TaskSource | null
  mine: boolean             // per the rule above, for the caller
}
export class Tasks {
  constructor(deps: { git, index, spaces, syncer, now?: () => Date })
  list(principal, filter: TaskFilter): Promise<TaskView[]>    // from the index; notes from the index's stored body (Index.bodies), for the returned tasks only (≤ 500); no Git reads
  get(principal, space, id): Promise<TaskView>
  create(principal, input: TaskInput & { space?: string }, via?): Promise<TaskView>   // space default: team if assignee is someone else, else personal
  quickAdd(principal, { text, tz, space?, project? }, via?): Promise<TaskView>         // parseQuickAdd + resolve +assignee
  update(principal, space, id, patch: Partial<TaskInput>, via?): Promise<TaskView>
  complete(principal, space, id, { tz }, via?): Promise<TaskView>
  reopen(principal, space, id, via?): Promise<TaskView>
  remove(principal, space, id, via?): Promise<void>            // to .trash like DELETE /file
  move(principal, space, id, toSpace, via?): Promise<TaskView> // one commit per space: create in toSpace, then trash
  people(principal): Array<{ email, name, handle }>             // members: owners of personal spaces in the registry, plus the caller
}
TaskFilter = { status?: 'open' | 'done' | 'all' (default open); mine?: boolean; project?: string; space?: string;
               dueBefore?: string /* YYYY-MM-DD inclusive */; dueAfter?: string /* YYYY-MM-DD inclusive */;
               dueAtAfter?: string; dueAtUntil?: string /* ISO, (after, until]: timed tasks only; reminders */; doneSince?: string /* ISO */; q?: string; limit?: number (≤ 500, default 500) }
TaskInput = { title, notes?, priority?, due? (YYYY-MM-DD[THH:mm] | null to clear), tz?, recur? (any rule parseRecurrence accepts, null clears),
              project? (null clears), labels?, assignee? (email or handle, null clears), order?, source? }
```

- `+handle` and assignee handles resolve against `people()` (email local part, then the email itself); unknown is `bad_request` "No member called …".
- `tz` must be an IANA zone (`assertTimeZone`); a timed due without one uses the request's `tz`.
- Sorting for `list`: open tasks by (due date ascending, nulls last; then time; then priority; then order; then created); done tasks by `completed` newest first.
- Meeting action items: when a task with `source.kind = 'meeting'` is completed, the server also ticks that line with `completeActionItem` (best effort: a `conflict` because the note moved on is logged and ignored). Reopening a non-recurring one unticks it the same way (`reopenActionItem`, `- [x]` back to `- [ ]` when that line still holds the item, ticked; commit `meetings: reopen "<text>"`). `GET /api/tasks/from-meetings` is `listActionItems` minus items that already have a task (any visible task whose `source` names the same space, path and text).
- Reminders (`tasks/reminders.ts`, `TaskReminders`): reuses the Meetings `ReminderStore` subscribers and `PushSender` (a member who turned on meeting reminders gets task reminders too). Every 30 s, for each subscribed member: open tasks that are **mine**, timed, with `dueAt` in `(now − 10 min, now + 30 s]` (filtered in `list` with `dueAtAfter`/`dueAtUntil`, before its 500 limit), not sent before (key `task <email> <id> <dueAt>`, `markSent`), payload `{ title: "Due now: <title>", body: project or "Hearth Tasks", url: "/tasks/today", tag: "task-<id>" }`. Started next to `meetings.reminders` in `main.ts` when a sender exists.
- Ramble (`tasks/ramble.ts`): `ramble(principal, { audio, mimeType, tz })` → the Dictate transcriber (`deps.dictation`'s `DictationTranscriber`, same keyterms) → `TASKS_MODEL` (default `claude-haiku-5-5`, config) with the transcript in `<ramble>`, today's date and weekday, and the member's project names in `<projects>`; it answers one quick-add line per task inside `<tasks>`…`</tasks>` (no other prose). Each line is parsed with `parseQuickAdd`. Returns `{ transcript, tasks: ParsedTask[] }` and saves nothing. ≤ 15 MB, ≤ 10 minutes, the same per-member rate limit as Dictate (30 a minute). The fake LLM (`scriptedResponse`) answers a `<ramble>` prompt with one line per sentence of the transcript (split on a `.` followed by a space or the end, so "1.5" stays whole; `;`; " and then "; " also "). An LLM failure (or an answer without `<tasks>`) returns the transcript split into sentences the same way (`rambleLines`), one task line each, cut at 200 characters.
- Todoist import (`tasks/todoist.ts`): `importTodoist(principal, { token } | { csv, projectName })` into the member's personal space, one commit. API: `https://api.todoist.com/api/v1/` `projects`, `sections`, `labels`, `tasks` (cursor-paginated: `results`, `next_cursor`), `Authorization: Bearer <token>`, 30 s timeout per request; the token is never logged, stored or returned. Mapping: content → title, description → notes, priority (API 4 = p1 … 1 = p4) → priority, `due.date`/`due.datetime` (+ `due.timezone`) → due/tz, `due.is_recurring` with `due.string` → `recur` if `normalizeRecurrence` accepts it (else the string is appended to the notes as "Repeats: …"), project name → project (Inbox → none), section name → a label, labels → labels, sub-tasks → their own tasks with "Sub-task of: <parent title>" as the first notes line, `id` → `source { kind: import, from: todoist, ref }`. Already-imported refs (a task with that `from`/`ref` in the member's personal space, or one they created; a teammate's import of the same rows doesn't count) are skipped, so a second import only adds new ones. CSV: Todoist's export columns (`TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE,…`), rows with `TYPE=task`, `PRIORITY` 1 = p1, `section` rows become a label on the tasks after them, `DATE` parsed with `parseQuickAdd(DATE, today)` (dates and "every …"), `projectName` from the file name. At most 5000 tasks an import. Result `{ imported, skipped, projects: string[] }`.

As built (server, 2026-11-11). Where the contract above left a choice open, the server does this:
- Listing reads no Git: frontmatter from `Index.listFiles`, notes from `Index.bodies(space, paths)` (the indexed text after the frontmatter, minus the blank line Hearth writes and trailing space). A file under `tasks/` that isn't named `tasks/<ULID>.md`, or whose frontmatter doesn't parse as `TaskFrontmatter`, is indexed (kind `task`, searchable) but left out of task lists. `get` and every write read Git.
- Sorting: on the same due date a date-only task comes before a timed one; a task with no `order` sorts after those with one; the last tie-break is the id.
- Filters: `project: ''` means tasks with no project (the Inbox); `mine: false` is no filter; `doneSince` drops only done tasks completed before it (open tasks pass); `q` is the index's full-text search over title and notes (kind `task`, best 100 matches).
- `tz` on PATCH is the member's zone: their today, and the zone of a timed `due` sent with it (a patch without `tz` uses the task's own zone, else UTC). It becomes the task's `tz` only when the patch sets a timed `due`, or the task already has a timed `due` with no `tz`; otherwise it changes nothing. The web sends the member's zone on every PATCH and completion; the `t`/`m` shortcuts and the detail's time field send a timed task's own `tz` to keep it. A `recur` with no due date (in the patch or on the task) sets `due` to `firstOccurrence(recur, today)`.
- `baseBlobOid` (PATCH): 409 only when the patch sets `title` or `notes` and that field differs between the version at `baseBlobOid` (read with `GitStore.readBlobText`) and the current one; field patches never 409.
- Completing a done task, or reopening an open one, commits nothing and returns the task. The meeting line is ticked after every completion commit (a recurring task's first one included), only when the member can access the note's space; any failure is logged and ignored.
- `remove` is one commit that adds `.trash/<YYYY-MM-DD>/tasks/<id>.md` (or `.trash/<YYYY-MM-DD>-<id8>/…` when that exists) and removes the task, message `tasks: delete "<title>"`, guarded and retried like other writes. `move` commits `tasks: move "<title>"` in both spaces (the copy first, then the trash); a task with that id already in the target is 409; into a personal space with someone else as assignee is 400; if the task changed between the copy and the trash, the copy is rewritten and the trash retried.
- `people()` names members other than the caller from their email (`nameFromEmail`), sorted by name. `projects()` lists team projects first, then by name. `source` is left out when the client sends none; MCP `add_task` writes `{ kind: mcp }`.
- Ramble: `Dictation.hear(principal, { audio, mimeType })` is the Dictate path without cleanup (rate limit, 15 MB, 10-minute WAV check, keyterms). An empty transcript returns `{ transcript: '', tasks: [] }` with no model call; the model gets 30 s; at most 50 tasks are returned. `tz` defaults to UTC when the query leaves it out; the accepted types are Dictate's (`audio/wav`, `audio/x-wav`, `audio/wave`, `audio/mp4`, `audio/webm`, parameters ignored).
- Todoist: the `labels` endpoint isn't fetched (a task's `labels` already carry names). The import body takes an optional `tz` (default UTC): a floating time is wall time in `due.timezone`, else that `tz`; a time with `Z` or an offset is converted into that zone; CSV `DATE` is parsed with today in it. Todoist answering 401/403 is 400 `bad_request` ("Todoist didn't accept that API token"); other failures and timeouts are `host_error`; no provisioned personal space is 403. An import of more than 5000 new tasks takes the first 5000, and running it again adds the rest. CSV: `@label` words in `CONTENT` become labels; a `DATE` that `parseQuickAdd` finds nothing in goes into the notes as "Due in Todoist: …"; `PRIORITY` 4 is none; rows have no id, so `ref` is `csv:` + the first 16 hex of SHA-1 over project, section, parent title and content, with `:<n>` added for the n-th identical row.
- Reminders list the member's tasks over the spaces the registry says they can access (`Tasks.accessibleSpaces`), not this process's provisioned ones, so a member who hasn't opened Hearth since a restart is still reminded of personal tasks. `MeetingServices` gains `pushSender`. `POST /api/test/reminders/tick` (test only) ticks task reminders too.
- MCP `list_tasks` defaults to 100 tasks.

### 12.3 API (`/api/tasks`)

```
GET    /api/tasks?status=&mine=&project=&space=&due_before=&due_after=&done_since=&q=&limit=  → { tasks: TaskView[] }
GET    /api/tasks/projects                     → [{ space, name, open: number }]   (visible spaces, projects with any task, open count)
GET    /api/tasks/people                       → [{ email, name, handle }]
GET    /api/tasks/from-meetings                → MeetingActionItems[] (see 11.2)
POST   /api/tasks                              TaskInput & { space?, tz } → 201 TaskView
POST   /api/tasks/quick                        { text, tz, space?, project?, source? } → 201 TaskView
GET    /api/tasks/:space/:id                   → TaskView
PATCH  /api/tasks/:space/:id                   Partial<TaskInput> & { tz?, baseBlobOid? } → TaskView
POST   /api/tasks/:space/:id/complete          { tz } → TaskView
POST   /api/tasks/:space/:id/reopen            → TaskView
POST   /api/tasks/:space/:id/move              { toSpace } → TaskView
DELETE /api/tasks/:space/:id                   → 204
POST   /api/tasks/ramble?tz=                   raw audio body (audio/webm, audio/mp4, audio/wav; else 415) → { transcript, tasks: ParsedTask[] }
POST   /api/tasks/import/todoist               { token } | { csv, projectName } → { imported, skipped, projects }   (session only, not access tokens)
```

`:space` access is checked like every space route (403). An unknown id is 404. Bodies are Zod-validated. Ramble's body limit is 15 MB.

### 12.4 MCP tools (added to §8.2's table)

| Tool | Input | Output |
| --- | --- | --- |
| `list_tasks` | `status?`, `mine?` (default true), `project?`, `space?`, `due_before?`, `q?`, `limit?` | `TaskView[]` |
| `add_task` | `text` (quick-add syntax, e.g. "Send deck fri p2 #Board"), `notes?`, `space?`, `tz?` (default UTC) | `TaskView` |
| `update_task` | `space`, `id`, any `TaskInput` field | `TaskView` |
| `complete_task` | `space`, `id`, `tz?` | `TaskView` |

The `search` tool's `kind` gains `task`.

### 12.5 Web (`apps/web/src/apps/tasks/`)

Fifth manifest in `apps/registry.ts`: id `tasks`, name "Hearth Tasks", label "Tasks", icon `tasks` (a checkbox; add it to `Icon.tsx`), route `/tasks`, folder `tasks`, `urlFor(space, path)` → `/tasks/item/<space>/<id>`. API client `src/api/tasks.ts`.

Routes: `/tasks` (Inbox: mine, open, no project; loaded with `project=`), `/tasks/today` (mine, overdue + due today, overdue in its own group; plus "From your meetings": `from-meetings` items with a checkbox that ticks the note and **Add to tasks**, which creates a task with `source.kind = meeting`, due today), `/tasks/upcoming` (mine, open, due in the next 14 days grouped by day, then Later; loaded with `due_after=<today>` so overdue tasks, which are in Today, don't use up the 500), `/tasks/project/<space>/<name>` (everyone's open tasks in that project, then a collapsed Done list), `/tasks/done` (mine, done in the last 30 days), `/tasks/item/<space>/<id>` (the list it belongs in, with the task's detail panel open), `/tasks/import` (Todoist: paste an API token, with a link to https://app.todoist.com/app/settings/integrations/developer, or drop CSV files).

- Sidebar (`TasksSidebar`): Add task (and `q`), Inbox, Today (open count), Upcoming, Done, Projects (team and personal, with counts), Import from Todoist.
- Quick add (`QuickAdd.tsx`): one line; tokens highlighted live with `parseQuickAdd` from `@hearth/format` (chips: date in words like "Fri 3:00 PM", priority, #project, @labels, +assignee); a Personal / Team switch (Team forced when assigning someone else; never for the member's own handle, and not for a handle the people list, still loading, can't place yet); Enter adds (`POST /quick`), Esc closes, Shift+Enter keeps it open for the next. A **Ramble** button (mic) records with `MediaRecorder` (up to 5 minutes, live timer, Stop), posts to `/ramble`, then shows the proposed tasks as editable quick-add lines with checkboxes and "Add N tasks" (each `POST /quick`, `source.kind = voice`).
- Rows (`TaskRow.tsx`): round checkbox colored by priority, title, notes first line, chips for due (red when overdue; "Today", "Tomorrow", weekday within 6 days, else "Nov 20"), recurrence icon, project, labels, assignee initials. Completing animates out and shows an undo toast for 5 s (Undo = reopen; for a recurring task, Undo restores the previous due by PATCH). Optimistic: the list updates first and rolls back with an error on failure.
- Detail panel (`TaskDetail.tsx`): title, notes (plain textarea; saved on blur), due date/time inputs, repeat (text with a hint, validated with `normalizeRecurrence`), priority, project (combobox of existing), labels, assignee (people list), Personal/Team move, source link (opens the meeting note line), Delete (confirm). Every field saves on change by PATCH.
- Keyboard (list focus, never while typing): `q` quick add, `j`/`k` or arrows to move, `x` or Space completes, Enter opens detail, `e` edits title, Delete/Backspace asks to delete, `1`–`4` set priority, `t` due today, `m` due tomorrow.
- Drag to reorder in Inbox and project lists (pointer events; mouse and touch), writing `order` as the midpoint of the neighbors (PATCH of the moved task only).
- Live: `hearthSocket.onChanged` with any path under `tasks/` refetches the current view (debounced 300 ms). A refetch never discards an optimistic change still in flight.
- Works at phone width (bottom sheet detail, full-width quick add, no hover-only controls).

### 12.6 Tests

- Format (`tasks.test.ts`): quick-add parsing, recurrence, dates and zones, the file.
- Server unit: list sorting and filters, the "mine" rule, assignee resolution, recurring completion, the patch-retry on a concurrent commit, the reminder window and once-only key, the ramble response parser (fake LLM), Todoist API mapping against a fake fetch (pagination, priorities inverted, sub-tasks, sections, recurring, skip already imported) and CSV parsing.
- Server integration (`test/integration/tasks.test.ts`): every route through `app.request` in dev auth: create/quick/patch/complete/reopen/move/delete commit authored by the member with the right message; personal tasks invisible to another member and 403 on their routes; a personal task can't be assigned to someone else; a meeting-sourced task ticks its meeting line on completion; from-meetings hides converted items; ramble with the fake transcriber and LLM; Todoist import (fake fetch and CSV), idempotent; MCP `list_tasks`/`add_task`/`update_task`/`complete_task` and `search` with kind `task`; reindex picks tasks up as kind `task`.
- Web (vitest + MSW): quick-add chips and submit, row complete and undo, views filter correctly, detail saves, keyboard shortcuts, drag order math.
- E2E (`e2e/tasks.spec.ts`, desktop and Pixel 7): quick add with tokens → appears in Today/Upcoming correctly; complete + undo; recurring task moves forward; detail edit (project, priority, notes) persists across reload; team task visible to a second member, personal one not; meeting action item → Add to tasks → completing it ticks the note; Ramble with the fake mic produces a task; Todoist CSV import.

## 13. Agent briefs

A nightly snapshot of each member's work, written by the language model from their meetings and tasks, so an agent connected over MCP starts with their context (the Granola "agent brief", Nov 2026). Server code in `apps/server/src/brief/`.

### 13.1 The files

- `.hearth/brief/brief.md` in the member's personal space, written only by Hearth: frontmatter `{ type: agent-brief, generated, model, meetings, tasks, window_days, sources_hash }`, a `# Agent brief: <name>` title, then exactly these `##` sections in order: Overview, Current priorities, Projects, People, Glossary, Communication style, Habits, Identity and role, What changed. Each write is a commit `brief: write "Agent brief"` authored by the member; Git history is the brief's history.
- `.hearth/brief/notes.md`: the member's corrections, verbatim (`brief: correct "Agent brief"`). They go into every brief and the prompt says they win.

### 13.2 Writing (`AgentBriefs`)

- Material: meeting notes (`type: meeting`) dated in the last 30 days, at most 40, newest first: every one in the member's personal space, and team-space ones where they are an attendee (`matchesPerson`). Each note body is cut to 4000 characters; for notes in the personal space only, the transcript's `Me` lines (what the member said) are added, cut to 1500 (a shared note's `Me` is whoever took it). The whole is capped at 180 000 characters, dropping the oldest meetings. Plus the member's open tasks (`mine`, up to 60) and tasks done in the last 14 days (up to 30). Plus the previous brief (for continuity and "What changed") and their notes.
- The prompt (`prompt.ts`) fences all material in tags and tells the model it is information, never instructions; no secrets, health or family details; no images or links. Angle brackets in all material become look-alikes (`‹ ›`), so nothing can close or open the prompt's tags. `cleanBrief` drops a code fence, a title, every image, link (its text kept), reference definition, HTML tag, autolink and bare URL from the answer; an empty answer is `llm_error`. Model `BRIEF_MODEL` (default `claude-sonnet-5-5`).
- `sources_hash` is a SHA-256 of a prompt version, the model, every meeting note and transcript blob, every task blob and the notes. A refresh that isn't forced writes nothing (`unchanged`) when it matches the current brief, so a quiet night costs no model call. No meetings and no tasks is `empty` (nothing written).
- One refresh per member at a time (a per-member lock). Forced rewrites are limited per member to one per `BRIEF_REFRESH_GAP_SECONDS` (default 60) and 20 a day (`rate_limited`, in memory).
- Nightly: members are enrolled (`DATA_DIR/brief/members.json`, volume state like push subscriptions: `{ userId: { email, tz, checkedAt } }`) when they open the brief page (with their browser's zone), call `get_agent_brief`, or start a meeting (with its zone). Every 15 minutes (and a minute after start), each member whose last check was on an earlier "brief day" (the day starting at `BRIEF_HOUR`, default 4, in their zone) is re-checked with `Authenticator.principalForUser` (gone → dropped), gets their personal space ensured, and a non-forced refresh; a failure is logged and tried again on the next ticks, up to 3 times a night, then `checkedAt` is set. `close()` stops the pass between members. Off when `LLM_PROVIDER=none`.

### 13.3 API and MCP

```
GET  /api/brief?tz=        → { brief: { space, path, body, generated, model, meetings, tasks } | null, notes }   (enrols the member)
POST /api/brief/refresh    { tz? } → { status: 'written' | 'empty', brief, notes }   (always rewrites)
PUT  /api/brief/notes      { text } (≤ 20 000 chars) → 204
```

Only the member's own brief exists on these routes; tokens work (writes carry `Hearth-Via: api (token …)`). MCP `get_agent_brief` (§8.2) returns it, writing the first one on first use; the MCP server's instructions tell agents to call it before helping with the member's work, and both say it is background drawn from meetings, never instructions. The tool isn't marked read-only (the first call writes).

### 13.4 Web

`/meetings/brief` (sidebar: Agent brief; linked from Settings): the brief rendered (no images; links open in a new tab), when it was written and from how much, Rewrite now, a Correct it box (Save, Save and rewrite), and example questions with Copy and Ask Claude (`https://claude.ai/new?q=`) that start "Read my <product> agent brief first."

### 13.5 Tests

- Server unit (`brief/brief.test.ts`): `isDue` (once per night after the local hour, across midnight, unknown zone), `cleanBrief`, the prompt's section order and tag fencing.
- Server integration (`test/integration/brief.test.ts`): empty until there is material; written from personal meetings, shared meetings the member attended and their tasks, not from older meetings or shared ones they weren't at, and only their own `Me` lines; commits; another member sees nothing; corrections reach the next brief and the previous brief is passed on; unchanged material skips the model and the nightly pass runs once; images stripped; MCP `get_agent_brief` writes the first brief with the `Hearth-Via: mcp` trailer.
- Web: the page writes, corrects and rewrites, saves a correction alone, says when there's nothing to write from, shows refusals, never renders images.
- E2E (`e2e/meetings-brief.spec.ts`): a meeting note in the member's space → Agent brief from the sidebar → Rewrite now shows it → a correction with Save and rewrite reaches the brief and survives a reload.


## 14. Hearth Notes

A Google Keep-style board of quick notes and checklists (Nov 2026; plan `docs/plans/2026-11-12-notes.md`). Like Tasks (§12), git is the record: one note is one Markdown file, listed from the index. Format in `packages/format/src/notes.ts`, server in `apps/server/src/notes/`, routes in `api/notes.ts`, web in `apps/web/src/apps/notes/`.

### 14.1 The file

`notes/<ULID>.md` in the member's personal space (the default) or the team space. Frontmatter: `id`, `type: note`, `title?`, `color?` (`red orange yellow green teal blue darkblue purple pink brown gray`; absent or unknown is the default paper), `pinned?`, `archived?`, `trashed?` (ISO instant), `labels?`, `created`, `created_by`, `updated`, `order` (higher first), `source { kind: manual | import | mcp, from?: keep, ref? }`. The body is the note's text. A note whose non-blank lines are all `- [ ]`/`- [x]` items is a checklist. New files come from `newNoteFile`; every later write patches frontmatter keys in place and swaps the body, so a hand-edited file keeps its YAML text.

### 14.2 Service (`Notes`)

- Reads come from the index (kind `note`, a migration re-kinded existing `notes/%` rows); bodies from `Index.bodies`. No Git read per note. Views: `board` (not archived, not trashed), `archive`, `trash`; filters `label`, `space`, `q` (full-text); at most 1000. Order: pinned first, then `order` desc, then id; trash by `trashed` desc.
- Writes are read → patch → commit, skipped when unchanged, retried 3 times. With `baseBlobOid`, a write is a 409 only if the title or body changed since that blob (color, pin and labels never conflict). Commit messages `notes: create|edit|pin|unpin|archive|unarchive|trash|restore|delete|move|empty trash "<name>"`, authored by the member, with `Hearth-Via` for tokens and MCP. `<name>` is the title, else the first line, cut at 60, else "Untitled note".
- Trash sets `trashed` (and unpins); Restore clears it, so an archived note goes back to the archive. Delete forever moves the file to `.trash/<date>/notes/<id>.md`. There is no system author for a background sweep, so opening the Trash view purges the viewer's visible notes trashed over 30 days ago, as that member; each file is re-read and skipped if it was restored meanwhile.
- Move to Team (or back) is one commit adding to the target and one removing from the source. Only the note's writer (`created_by`) can move a team note into a personal space.
- Keep import: one at a time per member, up to 5000 notes per call, one commit, idempotent by `source.ref` (the Takeout file name). `mapKeepNote` maps text, list items, title, color, pinned, archived, labels, timestamps and annotation links; trashed or empty Keep notes are skipped; attachments become a line "_Had N attachment(s) in Google Keep._".

### 14.3 API and MCP

```
GET    /api/notes?view=board|archive|trash&label=&space=&q=&limit=   → { notes: NoteView[] }
GET    /api/notes/labels                                             → [{ name, count }]
POST   /api/notes                { title?, body?, color?, pinned?, archived?, labels?, order?, space? } → 201 NoteView
GET    /api/notes/:space/:id     → NoteView (with blobOid)
PATCH  /api/notes/:space/:id     { title?, body?, color?, pinned?, archived?, labels?, order?, baseBlobOid? }
POST   /api/notes/:space/:id/trash | /restore | /move { to }
DELETE /api/notes/:space/:id     → 204 (delete forever)
POST   /api/notes/import/keep    { notes: [{ ref, note }] } → { imported, skipped }   (signed-in browser only)
```

Another member's personal space is a 403. MCP (§8.2): `list_notes`, `add_note`, `update_note` (also trashes and restores); `search` takes kind `note`.

### 14.4 Web

Rail app "Notes" at `/notes`: a "Take a note…" composer (title, text or New list) that saves on close; a board of colored cards dealt into columns left to right (`dealColumns`, two on a phone), Pinned then Others; ticking from the card; an editor dialog (a bottom sheet on a phone) that autosaves 700 ms after typing through one serialized write chain, with a "Someone else changed this" banner offering Show theirs or Keep mine. Tools: color, labels, pin, archive, trash, Move to Team, text ↔ checklist, and "Make a task" on a checklist line (a Hearth task in the note's space). Sidebar: Notes, labels, Archive, Trash, Import from Google Keep. Undo on archive and trash. Notes stay plain files, so Docs shows them in a `notes` folder.

### 14.5 Keep import

`/notes/import` links to Google Takeout (Keep only). The browser reads the `.zip` itself (`keepTakeout.ts`: central directory, zip64, `DecompressionStream('deflate-raw')`), reading only `…/Keep/*.json` entries, so photos never upload and export size doesn't matter. Loose `.json` files work too. It posts batches of 500.

### 14.6 Tests

Format (`notes.test.ts`): file round trip, checklist helpers, Keep mapping. Server unit (`notes/service.test.ts`): order, names. Integration (`test/integration/notes.test.ts`): writes and commit messages, conflicts, hand edits kept, personal vs team, move, 30-day trash, Keep import idempotency and token refusal, MCP, index. Web (`NotesPage.test.tsx`, `keepTakeout.test.ts`). E2E: `e2e/notes.spec.ts` (desktop) and `e2e/notes-mobile.spec.ts` (Pixel 7).

## 15. Hearth Whiteboard

An Excalidraw whiteboard inside Hearth (plan `docs/plans/2026-11-12-next-tools.md` §1; one person drawing at a time first, live drawing together second). Git is truth: **one board is one Markdown file**. The pure parts (file format, merge) are in `@hearth/format` (`packages/format/src/boards.ts`), shared by server and web; read that file, it is part of this contract.

### 15.1 The file

`boards/<ULID>.md` (`boardPath(id)`), in the team space or the member's personal space (only them).

````markdown
---
id: 01J...
type: board
title: Q4 flow
created: 2026-11-12T10:00:00Z
created_by: ada@acme.example
updated: 2026-11-12T10:05:00Z
updated_by: ada@acme.example
---
<!-- Hearth Whiteboard: open it in Hearth to draw. The words on the board, for search: -->
- Launch
- Pricing

```excalidraw
{"elements":[
{"id":"r1","type":"rectangle","version":3,...},
...
],"appState":{"viewBackgroundColor":"#ffffff"},"files":{"f1":{"mimeType":"image/png","path":"assets/2026/11/....png"}}}
```
````

- The word list is written from the scene's live text elements on every save (`boardBodyText`), so search and GitHub show what the board says. Search indexes only the word list (`boardSearchText`), never the JSON.
- The scene is one element per line, so diffs show which shapes changed. The fence is longer than any backtick run inside it.
- Images are never data URLs in the file: the web app uploads them through the assets API first, and `files` holds `{mimeType, path}` under `assets/` (the server refuses other paths and `..`). The schema strips any `dataURL`. Files no live element uses are pruned on save.
- Hearth writes the whole body on every save (the word list and scene), so text added by hand below the frontmatter doesn't survive a save; frontmatter keys are patched in place. `parseBoardBody` refuses a scene block that isn't a valid scene (the API answers 400, the file is left alone).
- Deleted elements stay as small tombstones (`{id, type, version, versionNonce, isDeleted, index}`) so deletes merge; at most 20,000 live shapes and 100,000 elements in all. `iframe` elements are refused: Excalidraw runs their HTML in a scripted frame. The editor also turns off embeds (`validateEmbeddable={false}`).

### 15.2 Saving and merging

`PUT /api/boards/:space/:id` takes `{scene?, title?, baseBlobOid?}`. When `baseBlobOid` isn't the file's current blob, someone saved in between: the server merges (`mergeScenes`) and answers `merged: true` with the result, which the client adopts. Merge rule: union of elements by id; when both sides have one, the higher `version` wins, a tie goes to the lower `versionNonce` (Excalidraw's own rule); deletes are tombstones (`isDeleted`), so a delete beats an older edit and loses to a newer one. A save sends only the canvas settings (background, grid) it changed since its last save; the server keeps the rest, so a stale copy never undoes someone else's. A save that changes nothing makes no commit. Commits are `boards: create|edit|rename "<title>"`, authored by the member, with the `unchanged` guard and three retries like tasks. `DELETE` moves the file to `.trash/`.

### 15.3 API and MCP

`GET /api/boards?space=&q=&limit=` (from the index, newest first, with each board's words), `POST /api/boards` (`{space?, title?, scene?}`, personal space by default), `GET|PUT|DELETE /api/boards/:space/:id`. Index kind `board` (titled "Untitled board" when it has no title). MCP: `list_boards`, `read_board` (title, words, shape counts; never the JSON). No drawing over MCP.

### 15.4 Web

`/boards` (the rail's Whiteboard): My boards / Team tabs, search, dotted-paper cards. `/boards/:space/:id`: title, Private/Team label, save status, "Embed in a doc", delete. Excalidraw 0.18 (MIT) loads only on the board route (lazy chunk; e2e W6 checks no other page pulls it); its fonts are self-hosted at `/excalidraw/fonts` (a Vite plugin copies them from the package), so nothing loads from a CDN. The theme follows Hearth's light/dark.

`BoardSession` (`apps/web/src/apps/boards/session.ts`, unit tested apart from Excalidraw) saves 2 s after the last real change (a signature of element ids/versions, background and images, so selection and pointer moves don't save), one save at a time, uploading new images first; it saves on tab hide, on leaving the route (the router waits) and warns on unload while unsaved. When the socket says the board's file changed, it loads it and merges it in (shapes and canvas settings) without touching the undo history; a change that arrives during a save is fetched once the save is done. Leaving the board waits for the last save; if saving keeps failing, it asks before leaving without it.

Docs embed: `[![Title](/boards/<id>.md)](/boards/<id>.md)` in a doc of the same space shows the board as an SVG (Excalidraw's `exportToSvg`, lazy) and the link opens the board.

### 15.5 Drawing together

Everyone with a board open is in that board's room: `GET /ws/boards/:space/:id` (`BoardRooms`, `apps/server/src/boards/rooms.ts`), in memory on the one machine. The first message authenticates exactly as on `/ws` (session JWT or dev user; access tokens refused, 4401); the member must be able to read the space (else 4403, checked again on every message, so a removed invite drops out). The server answers `{type:'ready', you, peers}`, tells the others `join`/`leave`, and relays two messages to everyone else in the room, stamped with the sender's peer id: `scene` (a batch of changed Excalidraw elements, at most 2,000 and 256 KiB per frame) and `pointer` (`x`, `y`, `button`, `tool`: pointer or laser). It stores nothing. It checks each element's `id`/`type`/`version` and that its geometry (`x`, `y`, `width`, `height`, `angle`, `points`) is finite, and refuses `iframe` as a save does (§15.1); junk closes the socket (1008) and nothing more from that socket is relayed. Each peer may send 120 messages and 2 MiB a second (the rest is dropped; the next save carries it), at most 50 people per board, a receiver with more than 4 MiB still queued is skipped until it catches up, and a peer that stops answering pings is dropped.

The browser side is `BoardCollab` (`apps/web/src/apps/boards/collab.ts`, tested apart from Excalidraw): it sends only elements whose version moved since it last sent or received them, batched every 40 ms and split under the frame limit counted in UTF-8 bytes (an element too big for a frame waits for the save); pointer moves at most every 50 ms; nothing while alone. Someone who joins gets, addressed to them alone (`to`), everything this editor already sent since its last save; `join`/`leave` always reach everyone, even a slow receiver. The sign-in frame is capped at 16 KiB, as on `/ws`. A refusal (4403, 1008, 1009) stops reconnecting; a full board (1013) retries after 30 s. `iframe` elements are dropped both ways. Incoming elements are collected and painted once per animation frame: restored, merged with Excalidraw's own `reconcileElements` (newer version wins, order follows each element's fractional `index`, and what this editor is editing right now is kept), and put in the editor without touching undo. The elements the editor then holds for those ids are marked seen, so the index fixes and restores Excalidraw makes are not sent back as new edits. `onChange` does nothing unless `hashElementsVersion` or the canvas settings moved, so panning and pointer moves cost nothing. Saving is unchanged: each editor saves what it has through `BoardSession`, and the server merges by element version, so a save that adds nothing new makes no commit. Images arrive with the sender's next save. A dropped socket reconnects with backoff and loses only cursors.

The header shows who else is here (initials in their color); Excalidraw draws their cursors with names.

Not yet: boards can't be embedded across spaces. Rooms live on one machine; a second Fly machine would need a shared relay.

## 16. Today

The home page: `/` opens `/today` (a phone's home-screen launch still goes to voice notes), and it is first on the rail and the phone bar. To make room on the phone bar, Clips is off it (phone browsers can't record the screen) and opens by link. Today has no sidebar (`AppManifest.sidebar: false`); the page takes the full width.

One read, `GET /api/today?from&to&date` (`apps/server/src/today/service.ts`, `api/today.ts`). `from`..`to` is the member's own day (local midnight to midnight, at most 26 hours, as instants) and `date` its calendar date, both from the browser, so "today" is theirs. It reads only the index and the calendar cache: no Git reads, no model calls (asserted in `today.test.ts`, which also holds it under 200 ms on 5,000 indexed files). It returns:

- `meetings`: the day's calendar events with the member's note for the event if there is one (`calendar_event_id`, own space first), and a Prep line: the latest earlier note of the same series (`calendar_series_id`), else the latest earlier note sharing two or more attendee emails; the line is the first readable line of that note's body (`prepLine`). A calendar that fails (no grant, Google down) gives `events: []` and its message in `error`; the rest still loads.
- `tasks`: the member's open tasks due today or before (`Tasks.list` with `mine`, `dueBefore`), overdue shown apart. Completing one uses the Tasks API and takes it off the page. A task added on Today is due today unless the line names a date.
- `actionItems`: open meeting to-dos no task came from (`Tasks.fromMeetings` with `fromIndex`, reading each note's body from the index instead of Git, with the index's `body_line` so line numbers are the file's own).
- `notes`: the member's own notes created in the last day that aren't pinned or labelled ("Unfiled"), newest 10.
- `docs`: docs in the member's spaces whose indexed `mtime` is in the last day, newest 10. The index keeps a file's `mtime` across reindexes when its blob is unchanged, and a space's first index stamps the epoch (`NEVER_CHANGED`), so neither a restart nor a fresh volume makes every doc look new.
- `briefcast`: always null until Briefcast ships; the page hides the card.

Everything comes from spaces the member can read (`visibleSpaces`), never another member's personal space. The page refreshes on any `changed` event (debounced 500 ms), on reconnect, and every minute.

### 16.4 Tiles and the layout

Today is two columns of tiles the member arranges (`apps/web/src/apps/today/TodayTiles.tsx`, plan `docs/PLAN-today-tiles.md`). The layout is one JSON file per member, `.hearth/today.json` in their personal space (`TODAY_LAYOUT_PATH`), so it is in Git and follows them everywhere. `packages/format/src/today.ts` parses it and does every edit (add, remove, nudge, move across, update). Parsing drops what it doesn't understand rather than failing: unknown kinds (from a newer version), a second copy of a single-use tile, repeated ids, and anything past 40 tiles. Only `board` may repeat; each Board tile keeps `{ space, id }` of the board it shows.

`GET /api/today/layout` returns `{ layout, saved }`, the default (Today as it was before tiles) until the member saves. `PUT /api/today/layout` validates and commits it (`TodayLayouts`, `apps/server/src/today/layout.ts`); saving an unchanged layout makes no commit. A file that no longer parses reads as the default.

Edit Today waits for the saved layout (so a stand-in never overwrites it), edits a draft, and saves on Done. Tiles being arranged are `inert`. Tiles with their own data (People, Recent files, Board, This week) load it themselves and reload whenever the page does. The day-summary tiles (Check-in, From your meetings, Unfiled notes) hide when they're empty, and show a placeholder in edit mode. Tiles render with no wrapper element, so a hidden one leaves no gap.

### 16.5 Header and weather

The top bar has the time (the browser's 12 or 24 hour format, ticking on the minute) and the day. Under it are a greeting and a "next up" line (next meeting with Join within 15 minutes, tasks due and overdue), worked out from `GET /api/today`.

Weather is opt-in per device. "Show weather" asks the browser for its position, rounds it to 2 decimals (about 1 km), and keeps it in `localStorage` only. `GET /api/today/weather?lat&lon` (`apps/server/src/today/weather.ts`) asks MET Norway's Locationforecast (free, no key; its terms want a User-Agent naming us, at most 4 decimals, caching and credit). Answers are cached 20 minutes per place (LRU, 500 places). A failure isn't retried for that place for a minute, and each member gets 10 uncached places a minute, since MET throttles by User-Agent and one member could otherwise get the whole instance blocked. The answer is in °C; the browser shows °F for US-style locales.


## 17. People

A light CRM nobody types into (plan `docs/plans/2026-11-12-next-tools.md` §3). Rail item "People", `/people`, no sidebar, off the phone bar.

### 17.1 Who is a person

An email seen in what the member can read (`visibleSpaces`): an attendee of a meeting note (`attendees`, `Name <email>` or a bare email), an attendee of an event on their calendar in the next 60 days, or the assignee of an open task. The member themselves isn't one. Someone who appears only in a teammate's personal notes doesn't exist for them: not on the list, a 404 for their page, not in `find_person`.

- `name`: the calendar's display name, else a note's `Name <email>`, else a member's name, else null (the page shows the email).
- `company`: the email's domain, except personal mail (gmail.com, outlook.com and the rest of `PERSONAL_MAIL_DOMAINS`), which is null. `team`: the domain is one of `ALLOWED_EMAIL_DOMAINS`, or they're a member (an invited person).
- `meetings`, `last`: the readable meeting notes they attended, newest first. `next`: their first event on the member's calendar from now.

### 17.2 Derived per request, no table

Unlike the plan's "rebuildable SQLite table", nothing is stored: `People` (`apps/server/src/people/service.ts`) reads the index's meeting frontmatter, the calendar cache and the task list on each request, the same reads Today makes. That keeps P2 (each member's own view) true by construction and leaves nothing to rebuild. If it ever gets slow, the cache goes in the index; it stays derived.

### 17.3 The About note

The only thing written down: a team file `people/<email>.md` (index kind `person`), frontmatter `email`, `updated`, `updated_by`, then the text. Every member can read and edit it, so the page says so. A save sends the version it edited when editing began (`blobOid`, null for a new note); a different version, or a note created meanwhile, is a 409 (`GitStore.commit`'s `unchanged` with a null blob means "must not exist", checked under the space lock). Commit `people: edit "<name>"`, authored by the member. Since the note is a team file, it can only be written for someone the whole team can already see: seen in a team meeting note, assigned a team task, or a member (`canEditAbout`; otherwise 403). Someone only in your own meetings or calendar gets no team file, which would tell the team they exist.

### 17.4 API and MCP

- `GET /api/people?q=` → `{ people: PersonSummary[] }`, most recent meeting first, then most meetings, then email; `q` matches name, email or company.
- `GET /api/people/:email` → `PersonView`: the summary plus `history` (up to 200), open `tasks` assigned to them, `about` `{ text, blobOid }` and `canEditAbout`.
- `PUT /api/people/:email/about` `{ text (≤ 20,000), blobOid | null }` → `{ blobOid }`.
- `GET /api/companies/:domain` → `{ domain, team, people, meetings }`; 404 for personal mail or a domain with no one readable.
- MCP: `find_person` (`q`, `limit`), `get_person` (`email`). `search_files` takes kind `person` for About notes.

### 17.5 Web

`apps/web/src/apps/people/`: the list with a search box, a person page (who they are, About edited in place, meetings, next meeting, open tasks) and a company page. Attendee names on a meeting note's header and on Today's meetings link to the person page (`PersonLinks`), except the member's own. Pages reload on `changed` events.

### 17.6 Tests

`test/integration/people.test.ts` (P1–P5, MCP), `apps/people/PeoplePages.test.tsx` and `MeetingNote.test.tsx` (P6), `e2e/people.spec.ts` (P7).

Live drawing together (W8: one WebSocket room per board relaying scene updates, cursors with names) is slice 2. Boards in other spaces can't be embedded across spaces.

## 18. Hearth Files

Team files and attachments, beside Google Drive rather than in place of it (plan `docs/plans/2026-11-12-files.md`). Bytes live in the object store; Git keeps one small pointer per file, so "delete the SQLite file and reindex" rebuilds the whole listing. The pure parts are in `@hearth/format` (`packages/format/src/files.ts`); the server is `apps/server/src/files/` and `api/drive.ts`; the web app is `apps/web/src/apps/files/` and `components/FilePicker.tsx`.

### 18.1 The pointer

`files/<ULID>.md` (`filePointerPath(id)`) in the team space or the uploader's personal space.

```markdown
---
id: 01J...
type: file
title: NDA Acme.pdf        # the file's name
folder: Legal/2026         # "" is the top level
size: 48211
sha256: 9f2c...
mime: application/pdf
key: files/01J...          # object-store key (fileStoreKey)
created: 2026-11-12T10:00:00Z
created_by: ada@acme.example
updated: 2026-11-12T10:00:00Z
share: k3P...              # only while a share link is on
text: extracted            # extracted | none | failed
---
The text pulled out of the file, at most 200,000 characters (MAX_FILE_TEXT_CHARS).
```

- Names go through `cleanFileName` (no slashes or control characters, 200 characters at most) and folders through `cleanFolder` (segments trimmed, no `.`/`..`, no leading or trailing slash).
- Folders are the `folder` field. A folder made with New folder and still empty is kept in `.hearth/files/folders.json`.
- Index kind `file` (top folder `files/`), titled by the name; the body (the extracted text) is what search, Meetings Ask and MCP `search` read.

### 18.2 Bytes and uploads

- The store is `meetings.audioStore` (R2 `files/<id>` in production, a folder on the volume in dev and tests). Bytes never go into Git.
- Uploads are chunked: `POST /api/files/uploads` (`{space, folder, name, size, mime}`) → `PUT /uploads/:id/chunks/:seq` (8 MB each, at most 2 GB a file) → `POST /uploads/:id/complete`, which joins the chunks on the volume while hashing (sha256), pulls out text, puts the file to the store, then commits the pointer (a `files:` commit authored by the member, with `Hearth-Via` from MCP). `DELETE /uploads/:id` cancels. An upload belongs to the member who started it.
- Text: PDF with `unpdf`; Word, PowerPoint and Excel by unzipping with `fflate` and reading their XML; plain text as is. A file whose text can't be read is still stored, with `text: failed`.

### 18.3 Reading, previews and share links

- `<img>`, `<video>` and `<iframe>` can't send the bearer token, so every view hands out short-lived signed URLs: an R2 presigned GET (with `inline` setting the content type and disposition) in production, or an HMAC-signed `/api/files/media/<space>/<id>?exp&sig` on the local store (a per-process random key; the path is exempt from sign-in like clip media and checked by signature). `?download=1` gives `Content-Disposition: attachment`.
- The local media route streams with Range support and sends `Content-Security-Policy: sandbox`, except a PDF, which gets `frame-ancestors 'self'` so the app can frame it; `main.ts` leaves a route's own CSP and `X-Frame-Options` alone when the route set them. `previewKind` is `image`, `pdf`, `video`, `audio`, `text` or `none`; SVG, HEIC and HTML are `none` and always download.
- A share link (`POST /item/:space/:id/share {on}`) puts a random token in `share:`; `/files/s/<token>` opens it for any signed-in member or invited person (never signed-out people, never revealing the space). Turning it off removes the token. A public "anyone with the link" switch is an organization setting left to Share pages.

### 18.4 API, MCP and the picker

- `GET /api/files/config`, `GET /api/files?space=&folder=&q=` (folders first, then files; `q` searches names and text), `GET /recent`, `GET|PATCH|DELETE /item/:space/:id` (`?text=1` adds the text; PATCH renames or moves to a folder; DELETE moves the pointer to `.trash/` and keeps the bytes), `POST /item/:space/:id/move {to}` (personal → team; team → personal only for the uploader), `POST|PATCH|DELETE /folders`, `GET /shared/:token`.
- MCP: `search` takes kind `file`; `list_drive_files` and `get_drive_file` (name, folder, size, link, text; never a signed URL).
- One picker (`FilePicker`) attaches a file to a Doc or meeting note (the paperclip in the top bar inserts a Markdown link at the cursor), a Note and a Task (appended to the body or notes, shown as chips). A personal file attached to a page outside that space gets a share link, so teammates reading the page can open it.
- Web: `/files` (Team files, My files, Recent), breadcrumbs, search, drop zone, upload tray with progress and cancel, rename, move, share, delete; `/files/:space/:id` opens the preview dialog; `/files/s/:token` is the shared view.

### 18.5 Guards and known limits

- Only the Files service writes `files/**` and `.hearth/files/**`: Docs saves, moves, restores and MCP `write_file` refuse them (`writablePath`), and the store key is always `fileStoreKey(id)`, never the pointer's own `key`. A pointer hand-made in Git can't name another file's bytes. (Someone who can push to the space's repo directly is trusted with the space anyway.)
- Finishing an upload is safe to repeat: a second `complete` waits for the first and returns the same file; a failure keeps the chunks for a retry (the hourly sweep removes uploads abandoned for a day) and deletes a stored object whose commit failed. The disk check counts every open upload (×3 on the local store).
- Text is read one file at a time, with a 60 s limit (then `text: failed`); PDFs over 50 MB and files over 100 MB are stored without text. pdf.js runs on the main thread.
- Signed links last up to an hour: turning a share link off stops new views at once, but a link already handed out works until it expires.
- Deleting a file moves its pointer to `.trash/`; the bytes stay in the store and there is no restore in the Files app yet. Folder rename and delete work from the index (at most 5,000 files a space) and take no per-file base check.
- Files isn't on the phone's bottom bar (it's full); on a phone it opens from links and attachments.

## 19. Booking links (Scheduling)

Personal booking links inside Meetings (plan `docs/plans/2026-11-12-next-tools.md` §4). Not its own rail icon: Meetings → "Booking links". The pure slot math and file schema are in `@hearth/format` (`packages/format/src/booking.ts`); the server is `apps/server/src/scheduling/` and `api/booking.ts`; the web app is `apps/web/src/apps/meetings/booking/` and the public page `/book/<handle>/<slug>`.

### 19.1 A link is a file

`.hearth/booking/<slug>.md` in the member's personal space (hidden, so not indexed; read with `listTree`/`readFile`). Frontmatter (`BookingFrontmatter`): `title`, `minutes` (15/30/45/60), `tz`, `hours` (per weekday, up to four `[HH:MM, HH:MM]` windows; default Mon–Fri 09:00–17:00), `buffer_before`, `buffer_after`, `notice_minutes` (default 240), `horizon_days` (default 30), `daily_cap` (null = none), `questions` (up to 3), `description`, `active`; unknown keys are kept. The slug is lowercase letters, digits and dashes (1–50). Hearth writes the whole file on each save (it's Hearth's own file); a save sends the version it edited (`blobOid`, null to create) and a different one is a 409. Commit `booking: edit "<title>"` / `booking: delete "<title>"`, authored by the member.

### 19.2 Slots

`openSlots(rules, busy, { now, from, to, booked })`: starts every `minutes` inside each working-hours window in the member's time zone (a start the clock skips at spring-forward doesn't exist; the earlier of a repeated fall-back time is used), not before now + notice, not after now + horizon, clear of every busy period by the buffers, and not on a local day that already has `daily_cap` bookings from this link. All instants are UTC; the booker's page shows them in the booker's own time zone.

Busy comes from Google's `freeBusy` over the calendars the member syncs (Settings → Calendars; primary when none chosen), so the public page never reads an event's title, attendees or anything but busy times (S2). Google is asked in whole UTC days with a day either side (so every local day the range touches is complete for the daily cap), and that answer is kept for 60 s, so nearby page views share it. A calendar `freeBusy` reports an error for fails closed: the page says it isn't available rather than show its times as free. Booked counts for the daily cap come from the member's events carrying the private extended property `hearthBooking=<slug>`.

### 19.3 Booking

`POST /api/book/:handle/:slug` checks, in order: the server can take bookings (a Turnstile secret, or the fake outside production; else 503 `not_configured`, S8), the link exists and is active (404), the rate limits (5 per IP per hour, IPv6 counted per /64; 20 bookings per link per day, counted only for bookings that are made, so bad tokens can't close a link; in memory; 429, S5), the booker isn't the member, the Turnstile token with Cloudflare's `siteverify` (403, S3), the slot is one `openSlots` offers right now against a live `freeBusy` (409 "That time was just taken", S4). Then it creates one event on the member's primary calendar: `conferenceData.createRequest` (a Meet link, `conferenceDataVersion=1`), the booker as attendee, `sendUpdates=all` (Google emails both sides; Hearth sends no email), the booker's name, email and answers in the description, and `extendedProperties.private.hearthBooking=<slug>`. The event id is a hash of member, link, start and booker, so a retry after a timeout is Google's 409, never a second event; Google's error details are logged, not shown to the booker. The public POST body is capped at 16 KB. The answers reach Meetings through the calendar: the event syncs like any other, and its description is the meeting's context when the note is enhanced (S6). Cancel and reschedule are Google's own.

The member's Google access is their Clerk Google token, looked up by the owner of the personal space named `<handle>` among the calendar's registered members (anyone who has opened Meetings). Writing needs the `calendar.events` scope: a member whose token lacks it can't create or edit a link and sees "Turn on booking links" with the steps (S7). Dev and test use the in-memory Google (`FakeGoogle`: `freeBusy`, event insert with a Meet link, extended-property filter) and a fake Turnstile that accepts the token `dev-pass`; production never uses the fake.

### 19.4 API

Signed in:
- `GET /api/booking` → `{ ready, missing: 'scope' | null, canTakeBookings, handle, links: BookingLink[] }`.
- `PUT /api/booking/:slug` `{ title, minutes, tz, hours, bufferBefore, bufferAfter, noticeMinutes, horizonDays, dailyCap, questions, description, active, blobOid | null }` → `BookingLink`. 403 without the scope.
- `DELETE /api/booking/:slug?blobOid=` → 204.

Public (`/api/book/`, no session):
- `GET /api/book/:handle/:slug?from=&to=` (at most 31 days) → `{ title, minutes, description, ownerName, questions, slots: Slot[], siteKey, canTakeBookings }`. 404 for a missing or inactive link.
- `POST /api/book/:handle/:slug` `{ start, name, email, answers, token }` → `{ start, end, meetLink }`.

### 19.5 Config

`TURNSTILE_SITE_KEY` (public, in `fly.toml`) and `TURNSTILE_SECRET_KEY` (Fly secret). The Google Cloud consent screen and Clerk's Google connection both carry `https://www.googleapis.com/auth/calendar.events`; members sign out and in once.

### 19.6 Tests

`packages/format/src/booking.test.ts` (S1), `test/integration/booking.test.ts` (S2–S8), `e2e/booking.spec.ts` (S9).
## 20. Share pages: read-only links and published pages

Pick 2 of the directory picks (plan `docs/plans/2026-11-12-share-pages.md`). Server `apps/server/src/shares/` and `pages/`, routes `api/shares.ts` and `api/pages.ts`, MCP `mcp/tools/pages.ts`; web `routes/SharedLinkRoute.tsx`, `components/ReadOnlyLink.tsx`, `components/PageFrame.tsx`, `apps/pages/`, `routes/org/LinkSharingSection.tsx`.

### 20.1 Read-only links

- A link is `share: <token>` (18 random bytes, base64url) in the frontmatter of a doc (kind `docs` or `other`), a meeting note, a note or a page pointer. Transcripts, tasks, boards, people and Files pointers are refused (Files keep their own links, §18.3). Git is the record: reindex rebuilds every link, a move keeps it, trashing the file ends it. `Index.filesByShareToken` finds the file; it is re-read from Git, so turning a link off counts before the index catches up.
- `GET|POST /api/shares {space, path, on}` → `{ token, url }` (`/s/<token>`), one commit `<app>: share|unshare "<title>"` authored by the member (`Hearth-Via` for tokens and MCP), retried on a concurrent change; a repeat is a no-op.
- `GET /api/shared/:token` → `{ kind: doc|meeting|note|page, title, markdown, html?, updated, updatedBy }` (the latest commit; never the space or path). `GET /api/shared/:token/asset?src=` serves a raster image only if the doc's markdown shows that exact `src` and it resolves under `assets/` (`Content-Security-Policy: sandbox`, `nosniff`). `authenticate` lets `/api/shared/` through with a session when there is one; without one both routes are 401 unless the organization setting `publicShareLinks` is on (checked before the token, so a guess from outside learns nothing). An unknown token is 404.
- `GET /api/sharing` (any member) and `PUT /api/sharing {publicShareLinks}` (an admin in a session; saved in `org/settings.json`, live at once, no restart). Default off. `/api/health` doesn't carry it.
- Web: the Share menu (docs and meeting notes) and the note editor's link button make a link (it is copied, with who can open it), copy it, or turn it off. `/s/:token` is outside the app shell: rendered markdown with links into the space shown as text and images through the asset route; a page in `PageFrame`; signed out and not allowed, a sign-in prompt that returns to the link.

### 20.2 Published pages

- A page is two files written in one commit: `pages/<ULID>.html` (as sent, at most 2 MB) and `pages/<ULID>.md` (frontmatter `id, type: page, title, created, created_by, updated, updated_by, share?`; body the page's visible text for search, kind `page`). Versions are the Git history of the `.html` file (`GET /api/pages/:space/:id?version=<oid>`). `writablePath` refuses `pages/**`, so Docs saves and MCP `write_file`, `move_file`, `delete_file`, `restore_file` can't touch them.
- MCP: `publish_page {title, html, id?, space?}` (team by default; `id` publishes a new version) → `{ space, id, title, url, version, … }`, commit `pages: publish "<title>"`; `list_pages`; `get_page {space, id, version?}` (HTML, versions, link); `share_link {space, path, on}` for anything §20.1 can share.
- `GET /api/pages` (every space the member can open, newest first), `GET /api/pages/:space/:id`, `DELETE` (both files to `.trash/<date>-<id8>/`, commit `pages: delete`).
- A page is shown in `<iframe sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms" srcdoc>`, never `allow-same-origin`: its scripts run in an opaque origin with no access to Hearth's cookies, storage or API. Web `/pages` (linked from the Docs sidebar; Pages belongs to Docs, not the rail) and `/pages/:space/:id` with a version picker, the link controls and Delete.

### 20.3 Known limits

- A shared doc's links to other files in the space show as plain text; `tasks` blocks show as code. SVG images don't load on a shared page (an SVG can carry script).
- A page's HTML is trusted to the publisher: it may load anything from the web inside its frame, and a signed-out reader (when the switch is on) sees it all.

## 21. Hearth Forms

Pick 3 of the directory picks (plan `docs/plans/2026-11-12-forms.md`). Written fresh: the good open-source form builders are AGPL and were looked at only. The pure parts are in `@hearth/format` (`packages/format/src/forms.ts`); the server is `apps/server/src/forms/` and `api/forms.ts`; the web app is `apps/web/src/apps/forms/` (rail app, no sidebar, off the phone bar) and the fill page `/f/<link>`.

### 21.1 Files

- A form is `forms/<ULID>.md` in the team space or a member's personal space. Frontmatter (`FormFrontmatter`): `id, type: form, title, description, questions, access (team|public), open, room (chat room id or null), link (the fill link's 24-character token), created, created_by, updated, updated_by`; unknown keys are kept. The body is the description and the question labels, for search. Index kind `form`.
- A question: `id` (`[a-z0-9]{1,16}`), `type` (`short`, `long`, `email`, `choice`, `multi`, `dropdown`, `rating`, `date`, `file`), `label`, `help?`, `required`, `options` (choice types only, 1–50, no repeats), `scale` (rating: 5 or 10), `show_if?: {question, is}` (an earlier choice-type question and one of its options). At most 100 questions. `questionsProblem` checks the whole set.
- An answer is `forms/<form id>/<ULID>.md` beside it: `id, type: form-answer, form, title ("Answer to <form>"), submitted, submitted_by (email, or null for someone signed out), answers ({question id: value})`; the body is the answers as text, for search and Ask. Index kind `form-answer`, so whoever can open the space can search it and nobody else.
- Only the Forms service writes `forms/**`: `writablePath` refuses it, so Docs saves, moves, restores and MCP writes can't forge a form or an answer. Every write is one commit, `forms: create|edit|delete|answer "<title>"`, authored by the member; a signed-out answer is authored `<PRODUCT_NAME> Forms <forms@<host>>` with `Hearth-Via: forms (public link)`.

### 21.2 Checking answers

`visibleQuestions(questions, answers)` walks the questions in order: one with `show_if` is shown only when its source question is shown and its answer is (for `multi`: includes) the option. `checkAnswers` drops hidden questions' answers, requires shown required ones, and checks each value: text lengths (500 short, 10,000 long), email shape, options, whole ratings in range, real `YYYY-MM-DD` dates, and files (3 per answer in all, 10 MB each). The fill page and the server run the same function.

### 21.3 The fill page

- `GET /api/form/:link` → `{ title, description, questions, access, open, canTakeAnswers, robotCheck, maxFiles, maxFileBytes }`; never the space or path. `authenticate` lets `/api/form/` through with a session when there is one (like `/api/shared/`). A team form without a session is 401 ("Sign in to answer"); an unknown link is 404. The form is found from the index by its `link` and re-read from Git, so closing it counts at once. Two forms can share a link only through a copy made in Git: then the team space's wins, and otherwise the link opens neither.
- `POST /api/form/:link`: JSON `{answers, token}`, or multipart with `payload` (that JSON) and `file:<question id>` parts. Before a byte of the body is read, a middleware runs the checks that need no body (the link, who may answer, open, a robot check on this server, the per-IP and per-form limits; `Forms.precheck`) and picks the body limit: 3 × 10 MB + 512 KB for a form with file questions, 512 KB for one without (the generic 12 MB limit skips this path). Checks, in order: the form exists, a team form has a member, it is `open` (409), a signed-out person on a public form has a robot check on this server (else 503 `not_configured`), 10 answers per IP per hour (429; requests with no client address share one count), the Turnstile token (403), 200 answers per form per day (counted when an answer is saved). File answers come only from uploaded parts: any file references in the JSON are replaced, so an answer can't point at another stored file. The files go to Hearth Files in the form's space, folder `Forms/<title>` (`Files.storeFormFile`, the same pointer and bytes as an upload, §18), then the answer is committed. A bad answer is 400 with `details.errors` per question.
- Turnstile is the Booking links check (§19.5, `robotCheckFor`): Cloudflare's widget with `TURNSTILE_SITE_KEY`/`TURNSTILE_SECRET_KEY`, the dev stand-in (`dev-pass`) outside production, and nothing in production without the keys, where a public form says it can't take answers yet (a signed-in member still can). The widget is `components/TurnstileWidget.tsx`, shared with the booking page.

### 21.4 Building and reading (signed in)

- `GET /api/forms` → `{ forms, canSummarize }` (every space the member can open, newest change first, with answer counts); `POST /api/forms {space, title}` makes a form with one question ("Your name"); `GET|PUT|DELETE /api/forms/:space/:id`. A save sends the whole form and the `blobOid` it edited; another is a 409. Delete moves the form and every answer to `.trash/<date>-<id8>/` in one commit.
- `GET …/answers` (newest first), `DELETE …/answers/:answer` (to the trash), `GET …/csv` (UTF-8 with BOM; one column per question; a cell starting `= + - @` gets a leading `'`), `POST …/summary` → `{ summary, tallies, read, total }`: counts for choice questions and the mean for ratings are worked out on the server; Claude (`ENHANCE_MODEL`) writes the themes of the newest 300 answers or 150,000 characters. 503 when AI isn't set up.
- Web: `/forms` (list and New form, with a space picker), `/forms/:space/:id` (questions: add, type, options, help, required, scale, show-when, move, duplicate, delete), `…/answers` (counts, summary, table, one answer in a dialog with its files linked to Files, delete, CSV), `…/settings` (who can answer, accepting answers, chat room, delete). Save is a button and ⌘S; leaving with changes asks first. A search hit on a form or an answer opens here (`formFileUrl`).

### 21.5 Chat rooms

An admin (in a session, not a token) adds rooms in Settings → Organization: a name and a Slack-compatible incoming webhook URL (`https://` only). Slack and Slack-compatible chat apps give each bot one per room. Before saving, Hotsauce refuses a chat app's plain message address (`…/rooms/<id>/<key>/messages`) and posts "Hearth Forms is connected" to the link; anything but a 2xx answering `ok` (what Slack and Slack-compatible addresses answer) is refused with the status and reason. The name is only a label; the link decides the room. They are kept in `DATA_DIR/forms/rooms.json` (mode 600), never in Git; `GET /api/chat-rooms` shows members the names and admins also the last four characters; `POST` and `DELETE /api/chat-rooms/:id` are admin only. A form picks a room or none. Each new answer posts `{text}`: the form's title, the first three answers (one line each, Slack's `& < >` escaped so an answer can't mention or link) and a link to the answer in Forms. The post runs after the answer is saved, in the background; a failed post is logged and never loses the answer or delays the reply.

### 21.6 Known limits

- Rate limits are in memory, per process: a restart resets them.
- A chat room's link must resolve only to public addresses (checked when it is added, not on each post; the connection isn't pinned, so DNS rebinding isn't stopped — only admins add links).
- Answers can't be edited; a deleted answer's files stay in Files.
- An uploaded file on a public form is stored as sent (Files previews never run HTML or SVG, §18.3).
- No MCP tools of its own yet: Claude reads forms and answers with `search` and `read_file`. Tables opens a form's answers as a live table (§22.6).

## 22. Hearth Tables

Pick 4 of the directory picks (2026-11-12): trackers with spreadsheet formulas, kept in Git. The formula engine is IronCalc (`@ironcalc/wasm` 0.9.1, MIT OR Apache-2.0, pinned), in the browser and on the server; the grid, the file format and the .xlsx reader and writer are written fresh (Baserow's MIT front end, Teable and NocoDB looked at only). Pure parts: `packages/format/src/tables.ts`; server: `apps/server/src/tables/`, `api/tables.ts`, `mcp/tools/tables.ts`; web: `apps/web/src/apps/tables/` (rail app, no sidebar, off the phone bar).

### 22.1 Files

- A table is `tables/<ULID>.md` in the team space or a member's personal space. Frontmatter (`TableFrontmatter`): `id, type: table, title, columns, created, created_by, updated, updated_by`; unknown keys are kept. The body is the cells as one fenced `csv` block (RFC 4180, LF between rows, quoted only where needed), with a fence longer than any run of backticks inside. Row 1 is the header row (the column names). Each cell is stored as typed: a formula as `=C2*D2`, `007` as `007`. Index kind `table`; search reads the CSV text.
- `columns[i]` is column i's `{ type, options?, width? }`; types `text, number, date, checkbox, choice, person, link` (an unknown type reads as text). Types shape how a cell shows and is entered; any cell can still hold a formula.
- Limits (`tableProblem`): 5,000 rows plus the header, 52 columns (A–AZ), 10,000 characters a cell, 2 MB of CSV, 50 options a choice column with no repeats.
- Only Tables writes `tables/**`: `writablePath` refuses it, so Docs saves and MCP `write_file` can't write one around the service. Commits: `tables: create|edit|delete "<title>"`, authored by the member (`Hearth-Via: mcp` through MCP).

### 22.2 Formulas

Excel syntax, worked out by IronCalc. A cell shows its formula's result (or an error such as `#DIV/0!`, `#NAME?`, `#CIRC!`); a plain cell shows what was typed, without a leading `'` (which keeps a value text). Formulas read typed numbers the way Excel does (`$12.50` is 12.5). The browser keeps the cells as typed and mirrors them into an IronCalc model (`sheet.ts`); after rows or columns are added or removed it takes back the formulas IronCalc rewrote. The server's `evaluateCells` (`tables/engine.ts`) loads IronCalc once and works out a whole table for MCP and exports. Measured: 20,000 cells with formulas load in about 64 ms with evaluation paused while loading; one edit re-evaluates in about 3 ms.

### 22.3 API (members; the space is checked in the service)

`GET /api/tables` (every space the member can open, newest change first); `POST /api/tables {space, title, cells?, fromForm?}`; `GET|PUT|DELETE /api/tables/:space/:id`. A save sends the whole table (`title, columns, cells`) and the `blobOid` it edited; another is a 409. Delete moves the file to `.trash/<date>-<id8>/`.

### 22.4 The grid

`/tables` lists tables (New table, Import, a space picker); `/tables/:space/:id` is the grid. Only rows near the scroll position are drawn. Click or arrow to a cell; type to replace it; Enter or F2 or a double-click to edit; Enter and Tab move on; Escape cancels; Delete clears the selection; shift-click or drag selects a block; ⌘A selects all. The formula bar shows and edits the cell as typed. Copy puts the values on the clipboard tab-separated (Sheets and Excel paste it); pasting text from them fills cells; pasting a block copied in Tables keeps its formulas and moves their references (`shiftFormula`). A column letter opens its menu: name, type, choice options, sort, a "contains" filter, insert and delete; right-click a cell for rows and columns. Drag a column letter's edge to resize. Undo and redo (⌘Z, ⌘⇧Z) keep the last 30 steps. Changes save a second after the last one, and on ⌘S or leaving the page; a 409 shows "someone else changed this table" with Reload. Sorting and filtering change the rows on screen only, never the file, so references keep meaning what they say; they aren't saved. Typed cells: numbers right-aligned with thousands separators, checkboxes toggle on click or Space, choice is a picker, date a date input, person a list of team members' emails (from People), link and person cells open as links (`http`, `https`, `mailto` only).

### 22.5 Import and export

`POST /api/tables/import` (multipart `space` and `file`, 5 MB) makes a table from `.csv`, `.tsv` or `.xlsx`. For .xlsx: the first sheet only; text (shared and inline strings), numbers, booleans, dates (by the cell's number format, as `YYYY-MM-DD`) and formulas (shared formulas expanded to each cell); the XML is unzipped at most 60 MB. `GET …/csv` is the values (UTF-8 with BOM; a value starting `= + - @` gets a leading `'`). `GET …/xlsx` is a one-sheet workbook with the formulas and the values the grid shows, numbers as numbers and `YYYY-MM-DD` cells as dates.

### 22.6 Form answers

`GET /api/forms/:space/:id/table` (`Forms.answerTable`) gives a form's answers as a table: Submitted, From (a person column), then one column per question (choice and dropdown → choice with the question's options, rating → number, date → date, the rest text), newest first. The web shows it at `/tables/form/:space/:id`, read-only and always current (Forms → Answers → Open as a table). "Copy to a new table" (`POST /api/tables {fromForm}`) makes an editable table in the form's space; an answer starting `=` is copied as text (`'=…`), never as a formula.

### 22.7 MCP

`list_tables` (`space?`, `q?` on the title), `read_table` (rows of values with formulas worked out, each formula by address, the columns with letter, name and type, the `blobOid`), `update_table` (`set` cells by A1 address and/or `append` rows; with the `blobOid` from `read_table` a changed table is refused), `create_table` (`rows[0]` the header row). Each returns the table's link.

### 22.8 Known limits

- One person edits at a time: two people editing the same table at once get a 409 and the second reloads. Live editing together, like Whiteboard's, is a later step.
- Sort and filter views aren't saved or shared.
- Cell styles (bold, colours, number formats) aren't kept: a table is its values and formulas. Imported .xlsx loses styles, merged cells, other sheets and charts.
- IronCalc's wasm is about 2 MB (730 KB gzipped), loaded only on Tables pages.
- A deleted table can't be restored from the trash in the app (`writablePath` refuses `tables/**`, as it does `forms/**`); it comes back from Git history.
- The .xlsx reader scans the XML with `indexOf`, never backtracking regexes, so a hostile workbook can't stall the server; workbook.xml, its relationships and styles.xml over 2 MB are ignored. A CSV import is checked against the row and column limits before it becomes a grid.

## 23. Saved links

Pick 5 of the directory picks (2026-11-12): a Pocket-style read-later list. "Save to Hotsauce" from the Chrome extension, the Android share sheet, an iPhone Shortcut, the paste box or MCP; the server keeps a readable copy, Claude adds a summary and tags, and search, Ask and Briefcast use them. Readable copies by Mozilla Readability (Apache-2.0) over linkedom (ISC), Markdown by Turndown and Joplin's GFM plugin (MIT); Linkding and Wallabag (MIT) for what to keep, Karakeep and Linkwarden (AGPL) looked at only. Pure parts: `packages/format/src/saved-links.ts`; server: `apps/server/src/links/`, `api/saved-links.ts`, `mcp/tools/links.ts`; web: `apps/web/src/apps/links/` (rail app "Links", no sidebar, in the phone Apps sheet).

### 23.1 Files

- A link is `links/<ULID>.md` in the member's personal space (default) or the team space. Frontmatter (`LinkFrontmatter`): `id, type: link, url, title, site, description, summary, tags, archived, saved, saved_by, fetched, fetch_error, words, tags_set, source` (`web | extension | share | shortcut | mcp`); unknown keys are kept. The body is the readable copy in Markdown (at most 200,000 characters). Index kind `link`; search reads the title and the copy.
- `tags_set` marks tags the member chose; Claude never replaces them. `archived` is "Done".
- Commits `links: save|read|done|unread|tag|edit|share|move|delete "<title>"`, authored by the member who saved or acted (`Hearth-Via: mcp` through MCP). The background `read` commit is authored by the member who saved it. Links aren't write-protected: a hand edit in Docs or `write_file` is fine, and the web treats `url` as untrusted (only `http(s)` becomes a link).

### 23.2 Fetching and the readable copy

- `fetchPage` (`links/fetch.ts`) fetches a page the safe way (the readable copy is made on the main thread, so the page is capped at 2 MB and Readability at 30,000 elements; a 1.4 MB list of 60,000 items reads in about half a second): `http`/`https` on ports 80, 443, 8080 or 8443; every address the name resolves to must be public (no loopback, private, link-local and metadata, carrier-grade NAT, multicast, reserved or documentation ranges; IPv6 only global unicast, and IPv4-mapped, NAT64, 6to4 and Teredo addresses judged by the IPv4 inside); the connection goes to the address that was checked (a `lookup` override, so no DNS rebinding); every redirect (at most 5) is checked the same way; 15 s in all; 2 MB after decompression (the decompressor is stopped at the limit); `text/html`, `application/xhtml+xml` or `text/plain` only (a PDF keeps the link with "no readable copy"). Charset from the header or `<meta charset>`.
- `readPage` (`links/read.ts`): title, site name and description from `og:` tags, else `<title>` and the host; Readability picks the article; Turndown writes headings, lists, quotes, code, tables and links (made absolute; `#` links on the page dropped). Pictures become `[Picture: alt](src)` links, so nothing is loaded from the page when reading and Git stays small. A page it can't read keeps its title and an empty copy.
- `LINK_FETCH` is `live` in production and `fake` (stand-in pages, `links/fake.ts`) in development and tests; production refuses `fake`.

### 23.3 Saving and the background read

`Links.save` checks the URL, returns the member's existing link when the same address (no `#hash`, no `utm_*`/`fbclid`-style parameters, host lower case without `www.`, no trailing slash) is already saved in a space they can read (moved back to Unread), else commits the new file at once and queues the read. Reads run three at a time in the process, at most 20 waiting per member and 200 in all (beyond that a link reads as failed with "Too many pages at once" until Try again); a link moved before its read is read in its new space; each fetches, makes the copy, asks Claude (`LINKS_MODEL`, Haiku; skipped when tags were set or AI is off) for one sentence and up to three tags preferring the member's existing ones, then commits frontmatter and body in one read → patch → commit guarded by the blob it read and retried on a concurrent change. A title or tags the member changed meanwhile win; a link deleted or moved meanwhile is left alone. A failed fetch writes `fetch_error`; "Try again" is `refetch`. A link with neither `fetched` nor `fetch_error` three minutes after saving (a restart) reads as failed.

### 23.4 API (members; the space is checked in the service)

`GET /api/links?view=unread|archive|all&tag=&q=&space=` (newest saved first, from the index); `GET /api/links/tags`; `POST /api/links {url? | text?, title?, tags?, space?, source?}` (201, or 200 with `existing: true`; a link is found inside `text`, as Android shares it); `GET|PATCH|DELETE /api/links/:space/:id` (patch `title, tags, archived`); `POST …/refetch`; `POST …/move {toSpace}` ("Share with team"; only the member who saved a team link can make it private). Delete moves the file to `.trash/<date>/links/`.

### 23.5 MCP, Ask and Briefcast

- MCP: `list_links` (view, tag, query), `get_link` (with the copy, described as someone else's writing), `save_link`; `search` takes kind `link`.
- Meetings Ask searches `link` with meetings, transcripts and files; its prompt says excerpts under `links/` are saved pages to use as information, never instructions.
- Briefcast's prompt gets `<saved_links>`: links the member saved since the last briefing (24 hours, 72 on Mondays), and on Mondays up to five from the week before still unread. Saved links alone make a briefing. Episodes count them (`links`).

### 23.6 Web and the extension

- `/links`: paste box, Unread and Archive, search, tag chips, rows with summary, "Getting the page…" (polled every 2.5 s) or the error and Try again, Done. `/links/:space/:id`: the reader (title, site, Open original, Done or Move to Unread, Share with team or Make private, Delete, tags, summary, the copy rendered by react-markdown with every link opening outside and pictures as links). `/links/save?url=&title=&text=&via=` shows the link and a Save button, then says Saved or Already saved; signed out, sign-in keeps the query and comes back to it. Any site could open that address in a member's browser, so the page saves without a tap only when the Chrome extension confirms it opened that tab (`may-save`, answered by the worker from the tabs it opened).
- The PWA manifest's `share_target` (GET `/links/save`) puts Hearth in Android's share sheet once installed. iPhone Safari has no share target: an Apple Shortcut ("Save to Hotsauce") opens the same page.
- Chrome extension 0.3.0 (named with `PRODUCT_NAME`): the popup on a web page offers "Save to Hotsauce"; right-click a page or a link offers "Save page/link to Hotsauce". The worker opens the save page in a background tab, remembers it in session storage (changes serialized), and the page posts `{source: 'hearth-page', type: 'link-saved', ok}`; the bridge (on Hearth origins only) relays it, and the worker closes only a tab it opened and puts a ✓ on the icon. A save tab that hasn't reported in 12 s (signed out) comes to the front. New permissions: `activeTab`, `contextMenus`.

### 23.7 Known limits

- The server fetches pages signed out, so paywalled or sign-in pages keep only what they show the public. Saving the page as the member sees it in Chrome is a later step.
- PDFs and other files keep the link without a copy (Files could read them later).
- "Done" on a team link is done for everyone.
- No import from Pocket or browser bookmarks; no highlights or notes on a link.

## 24. Check-ins

Basecamp's automatic check-ins, written fresh (plan `docs/PLAN-checkins.md`): an admin schedules a question; at that time each member gets a push reminder and a card on Today; they answer by typing or speaking; teammates reply under answers; once everyone has answered, or the day runs out, one summary goes to a chat room. Pure parts: `packages/format/src/checkins.ts`; server: `apps/server/src/checkins/`, `api/checkins.ts`, `mcp/tools/checkins.ts`; web: `apps/web/src/apps/checkins/` (rail app "Check-ins", no sidebar, off the phone bar).

### 24.1 Files (team space only)

- A check-in is `checkins/<ULID>.md`: `id, type: checkin, title (the question, ≤ 300), days (sun…sat, at least one), time (HH:MM), tz (the admin's zone when made), skip (emails not asked), room (chat room id or null), paused, created, created_by, updated, updated_by`; unknown keys are kept. The body is the question, for search. Index kind `checkin`.
- An answer is `checkins/<id>/<YYYY-MM-DD>/<ULID>.md`: `id, type: checkin-answer, checkin, date (the round), title, submitted, submitted_by, name, edited?, replies [{id, by, name, at, text}]`; the body is the answer (≤ 10,000; a reply ≤ 2,000, at most 200). One per member per round: a second answer edits the first. Index kind `checkin-answer`, so the team can search answers.
- A round's summary, once written, is `checkins/<id>/<date>/summary.md`: `type: checkin-summary, checkin, date, written, answered, missing, room, posted`, body the text posted. Its existence is the once-only record, so a restart or reindex never posts twice.
- Only this service writes `checkins/**` (`writablePath` refuses it). Commits are `checkins: create|edit|delete|answer|edit an answer to|reply to|summarize "<…>"`, authored by the member (the summary by the check-in's creator, named "Check-ins"); answers and replies retry three times on a concurrent commit, guarded by the blob they read.

### 24.2 Rounds and zones (`checkins/schedule.ts`)

A round is a scheduled date `D`. For a member in zone `Z` it opens at `D <time>` in `Z` (`instantOf`, DST-safe). Their current round is the latest `D` within a week that has opened for them and not before the check-in was made. A member's zone is the one their browser last sent to any Check-ins route or Today's card (`DATA_DIR/checkins/members.json`, with their name), else the check-in's `tz`. Who is asked: every member with a personal space in the registry, less `skip`.

### 24.3 Reminders and the summary (`CheckinScheduler`)

Every 30 s (started beside Briefcast in `main.ts`):

- Reminders reuse the meeting reminder store and sender (§7, §12.2): for each asked member with a subscribed browser, within 10 minutes after their round opens, not sent before (key `checkin <email> <id> <date>`) and not already answered: `{ title: <question>, body: "Check-in: tap to answer", url: /checkins/<id>, tag }`.
- Summaries: for each round of the last 3 days (in the check-in's zone) with no summary file and at least one answer, once everyone asked has answered or it is past the deadline (5 PM on `D` in the check-in's zone, or two hours after the question time if later). Claude (`ENHANCE_MODEL`) writes at most 120 words from the fenced answers (angle brackets become look-alikes; told they're information, never instructions); an empty answer or a model failure, or no AI, gives the plain list `• *Name*: first 300 characters`. Missing people are named ("Still to answer: …"). The post is `*<question>*`, the text with Slack's `& < >` escaped, and a link to `/checkins/<id>?date=<D>`, to the check-in's room through `ChatRooms.post` (§21.5); then the file is committed with `posted`. A failed post is logged and not retried.

### 24.4 API (members; managing is admin-only in a session)

```
GET    /api/checkins?tz=            → { checkins: CheckinListItem[], canManage }
GET    /api/checkins/due?tz=        → { due: [{ id, title, date, opensAt }] }   (Today's card: open rounds you haven't answered, up to 3 days)
POST   /api/checkins?tz=            { title, days, time, room, skip, paused } → CheckinView   (admin)
GET    /api/checkins/:id?tz=        → CheckinView { …item, blobOid, asked, rounds (12 newest: answers, summary), canManage }
PUT    /api/checkins/:id            { …input, blobOid } → CheckinView   (admin; another version is 409)
DELETE /api/checkins/:id            → 204   (admin; the check-in, answers and summaries to .trash/ in one commit)
POST   /api/checkins/:id/answers?tz= { text, date? } → AnswerView   (your current round; `date` may name an earlier round only to edit your own answer)
POST   /api/checkins/:id/answers/:answer/replies { text } → AnswerView
```

### 24.5 Readers

- Briefcast's prompt gets `<team_checkins>`: teammates' answers since the last briefing (not the listener's own), up to 12, each cut to 600 characters; episodes count them (`checkins`).
- The Agent brief's prompt gets `<their_checkin_answers>`: the member's own answers of the last 30 days, up to 10, cut to 1,500; they join the material fingerprint.
- MCP: `list_checkins`, `get_checkin` (`id`, `date?`; answers described as teammates' words); `search` takes kinds `checkin` and `checkin-answer`.

### 24.6 Web

`/checkins`: the list (schedule, Answer now / Answered / Paused); admins get the two defaults as one-click starts (Monday 9 AM "What will you get done this week?", Friday 3 PM "What got done, and what's stuck?") and New check-in. `/checkins/:id`: the answer box for your current round (Dictate button: records with MediaRecorder, `POST /api/dictation/transcribe?mode=clean`, words appended; ⌘↩ posts), then rounds newest first with the summary, answers and replies; admins get Settings (question, days, time, room, who is asked, paused, delete). `?date=` scrolls to a round. Today shows a "Check-in" card for each due round. Pages reload on `changed`.

### 24.7 Tests and known limits

Server unit `checkins/schedule.test.ts`; integration `test/integration/checkins.test.ts` (R1–R13, MCP); web `apps/checkins/Checkins.test.tsx` (R5, R6, R8, R9, R14). Limits: a member far from the check-in's zone may be asked after its summary went (their answer still lands in the round); a removed member keeps being asked until an admin unticks them; a failed chat post isn't retried; nobody is told when someone replies to their answer yet.

## 25. The assistant (Ask)

The plan, decisions and requirements are in `docs/PLAN-assistant.md`.

- **Tools.** No tools of its own: each request builds the member's MCP server (`createMcpServer`, §8)
  and connects an MCP client to it in-process over `InMemoryTransport`, so the assistant can do
  exactly what Claude can do through a member's token, as that member, and every write is a commit
  with a `Hearth-Via: assistant` trailer. Tools with `readOnlyHint` run in parallel; writes run one
  at a time so each one's Undo covers only its own files. `delete_file`, `move_file`, `share_link`
  and `publish_page` never run in the loop (`save_link` is left out: it fetches the web): the model is told they wait, and `POST …/confirm` runs the stored call once.
- **Loop.** `apps/server/src/assistant/agent.ts`: up to 20 model turns, streamed to the browser as
  Server-Sent Events (text deltas, tool start and result, confirm, done, error). The model is
  `ASSISTANT_MODEL` or the admin's choice (default Claude Sonnet 5.5), through the Anthropic beta
  Messages stream with prompt caching and adaptive thinking. `LLM_PROVIDER=none` answers 503.
- **Undo.** Before a write, the HEAD of each visible space is noted; after it, the paths changed by
  the member's own commits since then are stored as an undo record. Undo restores each path to its
  earlier version (or deletes a file the tool created) as a new commit, and refuses with 409 if
  someone changed the file since.
- **State.** `DATA_DIR/assistant.sqlite` (backed up nightly, not rebuildable from Git): conversations
  (owner, title, the API message history and the transcript the panel shows), undo records, and
  usage per member per month with an estimated cost from list prices. Conversations are per-member
  private state, like Dictate history, so they are not committed and never indexed.
- **Web.** `components/assistant/`: one panel mounted in the app shell, opened by `global.assistant`
  (⌘J) in the shortcut list or the corner button; `openAssistant(prompt?)` opens it from anywhere.
  The open doc or meeting is sent as context. Answers link files as `[title](<hearth:SPACE/PATH>)`,
  which the panel turns into in-app links.

```
GET    /api/assistant                          → { name, configured }
GET    /api/assistant/conversations            → { conversations }          (own only)
GET    /api/assistant/conversations/:id        → { id, title, display, … }
DELETE /api/assistant/conversations/:id
POST   /api/assistant/conversations/:id/messages  { text, context?, tz? } → text/event-stream
POST   /api/assistant/conversations/:id/confirm   { toolId } → { isError, text }
POST   /api/assistant/undo/:undoId             → { restored }               (409 if changed since)
GET    /api/assistant/usage?month=             → { month, members }         (admin)
GET    /api/assistant/settings                 → { model, monthlyLimitUsd, models, fromEnv }  (admin)
PUT    /api/assistant/settings                 { model?, monthlyLimitUsd? }  (admin; env wins)
```
