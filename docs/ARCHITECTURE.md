# Architecture and build contract

This is the contract between the modules of Hearth and between the agents building them in parallel. If something here conflicts with a PRD, the PRD wins and this file gets fixed. If you need to change an interface in this file, change it here first, in the same commit as the code.

The design of every part, in the order it was built.

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
  fly.toml                    one machine, one volume mounted at /data
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
ALLOWED_EMAIL_DOMAINS=example.com        # comma list; enforced server-side in both modes
HOST_KIND=local|forgejo|github
LOCAL_HOST_DIR=./.data/remotes               # local: bare repos as file:// remotes
FORGEJO_URL, FORGEJO_TOKEN, FORGEJO_ORG
GITHUB_TOKEN, GITHUB_ORG                     # token now; GitHub App credentials later behind the same adapter
HEARTH_COMMITTER_NAME="Hearth", HEARTH_COMMITTER_EMAIL="hearth@example.com"
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

**The `spaces` table is a cache too.** Ownership is recorded in Git in each repo's `.hearth/space.yaml` (`kind`, `owner`); on startup and on `hearth reindex`, the table is rebuilt from the clones' `space.yaml` files, so deleting `index.sqlite` loses nothing. `hearth reindex` rebuilds `files` and `spaces`; it leaves `recents`, `stars`, `conflicts` and `sync_state` alone.

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

- `ClerkAuth`: verifies the session token (`Authorization: Bearer` or Clerk cookie) with `@clerk/backend`, loads the user's primary email once per token (cached by `userId` for 5 minutes). Domain lock: email domain must be in `ALLOWED_EMAIL_DOMAINS`, else delete the Clerk user and return 403 `domain_not_allowed`. Authorized parties (the token's `azp`): `PUBLIC_URL`'s origin, plus `http://localhost:5173` (Vite) when `NODE_ENV=development`.
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

- The shell (`AppShell`), as built since 2026-11-10: an **app rail** (`AppRail`) on the far left, then the active app's sidebar (`SidebarFrame`: the app's name, the app's own body, the hearth glow), then the page. The rail draws the Hearth mark, one item per manifest in `APPS` (`src/apps/registry.ts`: icon, short label, ember wash and `aria-current="page"` when active, a dot on Meetings while a meeting is recording or paused), then `RAIL_LINKS` (apps outside Hearth, opened in a new tab: the team chat set in `CHAT_URL`), and at the bottom Settings and the account button (menu: name, email, Sign out, which unsubscribes this browser's reminders first). Each item lands where that app was last open (`/settings` belongs to no app and isn't remembered), and its route chunk is warmed (`manifest.preload`) when the pointer or focus reaches it. The middle scrolls when the window is short. Under 768px the rail is a tab bar along the bottom (Settings moves into the account menu so eight entries fit across 390px; more scroll inside the bar, never the page) and the sidebar is a drawer. A new app appears in the rail and in Cmd-K's "Go to" commands by its manifest and its line in `APPS`; it also needs its routes in `router.tsx` and its sidebar in `AppShell`. Cmd-K lists "Go to <app>" for every app and rail link.
- `AppShell`, `Sidebar`, `SpaceSwitcher`, `FileTree` (lazy per directory, drag to move, context menu: new doc, new folder, rename, move, delete), `TopBar` (breadcrumbs, `SaveState`, reading-view toggle, Share menu).
- `MarkdownEditor`: CodeMirror 6, `@codemirror/lang-markdown` with GFM, our live-preview extension (`livePreview.ts`): heading sizes, hidden markers on inactive lines, bold/italic/strike/code styling, clickable links, toggleable `- [ ]` checkboxes, inline image widgets, fenced-code highlighting, folded frontmatter. Shortcuts: Cmd-B/I/K, `[[` autocomplete (writes a relative link). Paste/drop image → upload → insert link.
- `ReadingView`: `react-markdown` + `remark-gfm` + `rehype-highlight`, callouts rendered.
- `HistoryPanel` (commits, click to view version, compare → `DiffView`, Restore), `PropertiesPanel` (frontmatter fields), `ConflictResolver` (ours/theirs side by side, editable result).
- `CommandK` (`cmdk`): titles first, then full text; Enter opens.
- `useDocument(space, path)`: load → `{content, blobOid}`; edits → debounced autosave to the server buffer is **not** a thing in P0: the client holds the draft and PUTs after `idleCommitMs` of no typing, on route leave, and on Save version. On `merged` adopt the content; on 409 open the resolver. On WS `changed` for the open path with no local edits → refetch.
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
- `Dockerfile` builds both apps; runtime image has `git`; `DATA_DIR=/data`. `deploy/fly.example.toml` mounts a volume at `/data`; `scripts/deploy-fly.sh` deploys a new instance (docs/self-host.md).

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

Config additions: `ASR_PROVIDER=fake|deepgram` (default fake in dev/test, deepgram in production), `DEEPGRAM_API_KEY` (required with deepgram), `LLM_PROVIDER=fake|anthropic` (default fake in dev/test, anthropic in production), `ANTHROPIC_API_KEY` (required with anthropic), `ENHANCE_MODEL=claude-sonnet-5-5`, `CHAT_MODEL=claude-opus-5-5`, `KEEP_AUDIO=false` (whether Stop keeps audio when the client doesn't say), `AUDIO_STORE=none|local|r2` (default r2 when `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET` are all set, else local (`DATA_DIR/kept-audio/`, on the volume); none hides Keep audio and Clips; `KEEP_AUDIO=true` with none is refused). Routes: `GET /api/meetings/settings → { keepAudio: { available, byDefault } }`; `GET /api/meetings/audio?space&id&track → audio/wav` for anyone who can see the space, reading the key from the pointer file, which must be the meeting's own key in that space. Meeting reminders (PRD §6.1): `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` (both or neither; off without them), `GET /api/meetings/reminders → { publicKey | null }`, `POST /api/meetings/reminders { subscription }`, `DELETE /api/meetings/reminders { endpoint }` (own subscriptions only). Subscriptions and sent reminders live on the volume (`DATA_DIR/push/state.json`), not Git or SQLite: they're device state. `MeetingReminders` ticks every 30 s; for each subscribed member it reads the calendar for the next 90 s and pushes `{ title: 'Take notes for “<title>”?', body, url: '/meetings/start?event=<id>', tag }` once per event with attendees to each of their browsers, forgetting subscriptions the push service answers 404/410. The service worker imports `public/push-sw.js` for the push and click handlers; a click focuses an open Hearth tab and moves it in-app (`hearth:navigate` message, `src/lib/swNavigate.ts`), never by a page load, which would end a recording there, else opens a window. The toggle is on Meetings home; each visit re-sends a subscribed browser's subscription (resubscribing if the server's key changed), so one the server dropped comes back. Sign out unsubscribes the browser first, so the next person on it doesn't get the last member's reminders. Production refuses `fake` providers. `createServices(config, { transcriber?, llm?, calendar? })` takes stand-ins for tests.

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

A Manifest V3 extension, not on the public Chrome Web Store: the Dockerfile builds it for the deployed Hearth (`HEARTH_URL`, default `https://office.example.com`) and puts the zip at `/downloads/hearth-meetings-chrome.zip`; `/meetings/extension` explains Load unpacked. Permissions: `tabCapture`, `storage`, host `https://meet.google.com/*`; a content script (`bridge.js`) runs only on the Hearth origin.

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

**Dev and test.** Without Clerk, the same `GoogleCalendarHttp` runs against `fakeGoogleFetch(model)`, an in-memory Google (`FakeGoogle`) with sync tokens and 410s; the token is `fake-token:<email>`. Each member is seeded on first sight with `FakeCalendar.events()` (Acme sync in a minute or two with Meet code `abc-defg-hij`, series `fake-acme-series`; Design review later) plus past meetings for coverage (Pipeline review, series `fake-pipeline`, yesterday and a week ago; Intro call with Bolt two days ago; a declined Offsite planning yesterday) and a second calendar `team@fake` ("Team"). Production refuses the fake. `FakeCalendar` still works as a `CalendarSource` override in tests. With `NODE_ENV=test` only, `/api/test/*` exposes hooks for e2e: `POST /api/test/calendar/add { id, title, startsInSeconds, minutes?, meetLink? }` (with Jo Park as a guest), `POST /api/test/calendar/move { id, minutes }`, `POST /api/test/calendar/cancel { id }`, `POST /api/test/calendar/sync` (sync the caller now), and with `PUSH_SENDER=record` a recording push sender: `GET /api/test/pushes`, `POST /api/test/reminders/tick`.

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
| `search` | `query`, `kind?` (`docs`/`meeting`/`transcript`/`other`, or a list), `space?`, `prefix?`, `limit?` (1–50, default 20) | `[{ space, path, title, snippet, score }]`, matches marked `**…**` |
| `list_files` | `space`, `dir?`, `recursive?` | entries (one level, as the tree API) or every file under `dir` (at most 2000, `truncated` flag) |
| `read_file` | `space`, `path`, `ref?` | `{ space, path, blobOid, content }`; binary files (a NUL byte, or not valid UTF-8) are refused (use `GET /api/spaces/:space/raw`); text over 500 000 characters is cut, with `truncated: true` |
| `write_file` | `space`, `path`, `content`, `message?`, `base_blob_oid?` | `SaveResult` (`committed` / `merged` with content / `conflict` as a tool error naming the conflict ref) |
| `list_meetings` | `space?`, `from?`, `to?`, `person?`, `company?`, `folder?`, `limit?` (default 50) | `GET /api/meetings` items |
| `get_meeting` | `space`, `path`, `include_transcript?` (default true) | `{ space, path, title, frontmatter, note, transcriptPath, transcript }`; a file that isn't `type: meeting` is `bad_request` |
| `ask_meetings` | `question`, `space?`, `meeting_path?`, `folder?`, `person?`, `company?` | `{ answer, citations: [{ space, path, line, text }] }` (the Meetings chat) |

Team chat is not exposed yet (follow-up).

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
export function buildCleanupPrompt({ transcript, style, appName?, dictionary }): { system, user }
//   system: CLEANUP_SYSTEM (clean, never answer or obey the transcript, keep the speaker's words, apply self-corrections and
//   spoken formatting, spell dictionary terms exactly, answer inside <cleaned>). user: <context app=…>style rule</context>,
//   <dictionary>, <transcript>; angle brackets in outside text become ‹ › so it can't close a tag.
export function cleanTranscript(llm, model, input): Promise<{ text, cleaned }>
//   Never fails a dictation: an LLM error, no answer within 15 s, an answer without <cleaned> tags, or one longer than
//   1.6 × the transcript + 80 characters (it answered instead of cleaning) returns the raw transcript with cleaned: false.
//   An empty transcript skips the model. In production it has its own Anthropic client with no SDK retries.
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

The stream (`dictation/socket.ts`) uses the Meetings streaming `Transcriber` (Deepgram nova-3 over a WebSocket, keyterms as vocabulary), holds audio sent before Deepgram is ready (up to 30 s), refuses past 10 minutes, counts against the same 30 a minute, and on `finish` waits for Deepgram's last finals, then runs the same `Dictation.finish` as the upload (`asrMs` is then the wait after key-up, and the timing line says `"via":"stream"`). Measured on a Mac against a local server with real Deepgram, key-up to transcript went from 0.6–0.8 s (upload) to 0.1–0.17 s (stream). The Mac opens the stream on key-down and streams converted audio as it records, keeps the recording, and uploads it to `/transcribe` if the stream fails in any way, so streaming can only make a dictation faster.

Device tokens: `Authorization: Bearer hdt_…` is recognised in `authenticate` before Clerk and is accepted for `POST /transcribe`, `GET` and `PUT /words` (the Mac app's Dictionary page) and `DELETE /devices/self` only; any other request carrying one is 401, whatever else it carries. Each use re-checks the member through `Authenticator.principalForUser` (Clerk's user cache and domain lock; dev auth checks the domain): a deleted account is 401 and a refused domain 403, and both revoke all that member's devices. The body limit is 15 MB for `/transcribe`, 12 MB elsewhere. Neither the audio nor the text is logged or stored.

### 9.3 Web (`apps/web/src/apps/dictate/`)

`/dictate` is the third app in the switch. Download for Mac (`/downloads/HearthDictate.dmg`; the zip stays as a fallback), first-install steps for Gatekeeper (Done → Privacy & Security → Open Anyway, with a button to that pane), Connect this Mac (`POST /devices`, then `hearth-dictate://connect?token=…&server=<origin>`, with the same link shown as a code to paste if the app isn't installed), connected Macs with Disconnect, and My words / Team words editors.

### 9.4 Mac app (`apps/dictate-mac/`)

Swift package, macOS 14+, built with the Command Line Tools alone. `DictateCore` is the pure, tested part: `WAV.encode`, `StreamingResampler` (any rate and channel count → 16 kHz mono Int16, box-filtered), `HotkeyStateMachine` (hold to talk; presses under 0.3 s are ignored; a second press within 0.4 s of a short tap is hands-free until pressed again; Esc cancels and is swallowed only while recording; another key while holding is a shortcut, not a dictation), `ConnectLink` (https only, http only for localhost; origin only), `DictationClient`, `PasteboardSnapshot`, `DictationHistory`. `HearthDictate` is the app: a CGEventTap (Accessibility) on flagsChanged/keyDown for Right Option, Right Command or Fn; a new AVAudioEngine per dictation, converted as it records, stopped at 7.5 minutes (under the 15 MB limit); a borderless non-activating panel that is never key or main, shown with `orderFrontRegardless`; on a result, if the app frontmost at key-down is still frontmost and Accessibility is granted, the pasteboard (every item and type) is saved, the text written (marked `org.nspasteboard.TransientType`), ⌘V posted with only the Command flag, and the old pasteboard put back 1 s later (Electron apps read it late) unless something else wrote to it meanwhile; the app's own ⌘V carries a marker in `eventSourceUserData` so its key tap ignores it; a new dictation can't start while the last one is being written up; otherwise the text is left on the clipboard with "Copied — press ⌘V". A retryable failure (network, 5xx, 429) keeps the request in memory for "Retry last dictation"; a 401 forgets the token. The token and its server are kept together in `~/Library/Application Support/HearthDictate/connection.json` (0600, in a 0700 folder), so the server can't be changed without connecting again. Not the Keychain: a self-signed app's legacy Keychain items are bound to each build's code hash, so every update asked for the login password; the token is scoped to dictation and word lists and revocable on /dictate. A 0.1.x Keychain item is read with Keychain interaction turned off (never a prompt) until a connection file exists: if it can be read it moves to the file, otherwise the member connects again; either way the old item is then deleted, also with interaction off. Connecting first asks Hearth whose token it is (`GET /words` → `account`); a link (any web page can open one), another server, or replacing a connection asks the member, naming the account; a replaced connection and Disconnect revoke themselves (`DELETE /devices/self`). If macOS turns the key tap off, it is turned back on and a release missed meanwhile is caught up from the current modifier flags. History (text, cleaned or not, app, time, audio length, word count, timings; never audio) is kept on this Mac only, in `~/Library/Application Support/HearthDictate/history.json` (0600, in a 0700 folder, written off the main thread via a private temp file after the paste; a file it can't read is set aside, not overwritten), pruned past the member's retention (7, 30 or 90 days, default 30) at launch and every six hours, and never uploaded.

The main window (`MainWindow.swift`, SwiftUI `NavigationSplitView` in Hearth's colours) opens when the member launches the app (not as a login item), on reopen once set up, and from the menu: Dictations (7 days / 30 days / all: total words; time saved = words ÷ 40 wpm − speaking time, never negative; words per minute of speech; top apps with their icons; the month's activity grid; recent dictations, searchable, with Copy and Paste), Dictionary (both word lists over `GET`/`PUT /words`), Settings (open at login, meeting reminders, the suite's server; hotkey, mode, live permission rows, account and Disconnect, history retention and Clear). Since 0.2.0 it opens from ⌘, (Settings) and the app menu's Dictate…, not at launch. The Command Line Tools' SwiftUI has no `@State` (its macro plugin ships with Xcode), so view state lives on the model. `HearthDictate --render-previews <folder> [--dark]` draws each page with made-up history held in memory, for checking the design without screen access.

`scripts/build-app.sh` builds a universal binary, writes Info.plist (`dev.hotsauce.dictate`, the name from `Brand.swift`, the microphone and camera strings, the `hearth-dictate` and `hearth` URL schemes; the camera entitlement), signs it, and writes `release/HearthDictate.dmg` (the app beside an Applications link) and `release/HearthDictate.zip`, both committed: the Linux Docker build copies them to `/downloads/`. Signing, in order: a Developer ID identity (hardened runtime, timestamp); `Hotsauce Local Code Signing`, a self-signed identity that `scripts/create-signing-identity.sh` creates once in the build Mac's login keychain (hardened runtime), so every build has the same designated requirement and macOS keeps Microphone and Accessibility across updates; else ad hoc, which changes with every build and makes members grant Accessibility again. Recreating the identity (a new build Mac) is running that script again; members then re-grant once.

Opening the app while it runs (`applicationShouldHandleReopen`) shows the suite window. The setup window opens at launch until it has been closed once; it says what's missing in one line (microphone, Accessibility, the key tap, the connection) and names the connected account. The menu bar icon has a fixed autosave name (`HearthDictate`), starts near the right edge beside Control Center (`NSStatusItem Preferred Position HearthDictate` = 120 when unset) instead of the left end where a MacBook's notch hides new icons, can't be dragged out, and follows a Show in menu bar setting; when it is on but not on screen (occluded, off-screen, or not allowed in System Settings → Menu Bar) Settings and the setup window say so and link to the Menu Bar settings. Every 2 s the app re-checks the permissions, restarts or re-enables the key tap, updates the menu bar icon, and writes what it sees to `status.*` in its defaults (including `status.menuBarIconShown`) (`defaults read dev.hotsauce.dictate`) for diagnosis. If Accessibility is on but the tap still can't start, the window offers Quit and reopen. `HearthDictate.app/Contents/MacOS/HearthDictate --transcribe-file <path> [--literal] [--app-name N] [--app-bundle B] [--server URL]` runs the same upload with `HEARTH_DICTATE_TOKEN` (never the saved connection) and prints the JSON, for end-to-end tests.

### 9.4.1 The suite window (0.2.0, plan `docs/plans/2026-11-11-mac-app.md`)

The app is a Dock app (`.regular`, no LSUIElement) whose main window (`SuiteWindow.swift`) is the whole web suite in a `WKWebView`: the default persistent `WKWebsiteDataStore`, so the Clerk session survives relaunch; `applicationNameForUserAgent` Safari's version string, so the user agent is exactly Safari's and Google's sign-in page accepts it. Closing the window hides it: the page keeps its session, a recording, and the reminders' calls. `SuiteRouter` (`DictateCore`, tested) decides each navigation: the server's origin and sign-in hosts (`accounts.google.com`, `clerk.`/`accounts.` + the server's host, `*.clerk.accounts.dev`, `clerk.com`) stay in the window; a clicked link or a new window elsewhere goes to the default browser; other schemes (mailto, `hearth-dictate://connect` from the Dictate page) to their app; redirects and iframes elsewhere load (sign-in hops through hosts that can't be listed). A new window on the suite loads in the main window. Downloads: a response WebKit can't show or marked `attachment` becomes a `WKDownload` to `~/Downloads` (`DownloadName.unique`, `name 2.ext`, never outside the folder); a click on `a[download]` with an http(s) href is caught by a user script and downloaded natively, because WebKit ignores the attribute on another origin's link (a clip's presigned storage URL). Uploads use the open panel; `alert`/`confirm`/`prompt` are sheets; camera and microphone requests from the server's origin are granted (macOS asks once per app; the camera entitlement and usage string are in the bundle), others are prompted. Menus: App (Settings… ⌘,, Dictate…), File (Close ⌘W), Edit, View (Reload ⌘R, zoom, full screen), Go (Back ⌘[, Forward ⌘], Home ⇧⌘H, the rail's apps on ⌘1–⌘5 from `Brand.railShortcuts`), Window. Opening a path while the page is on the suite uses `history.pushState` + `popstate`, so React Router changes route without reloading (an open recording survives); otherwise it loads the URL. A failed load shows a small page with Try again.

Deep links: `hearth://<path>` (scheme from `Brand.urlScheme`) and `hearth-dictate://open?path=/x` open that path, only ever on the configured server (`SuiteRouter.url(forPath:)` refuses full URLs and `//host`). The server is Settings' value, else the server Dictate is connected to, else office.example.com.

Meeting reminders (`Reminders.swift`, rule in `DictateCore.ReminderPlanner`): every 30 s, `GET /api/calendar/upcoming` for the next 5 minutes, run as `fetch` inside the signed-in page (`callAsyncJavaScript` in the page world, only while the page is on the suite's origin) with `window.Clerk.session.getToken()` as a bearer, else dev auth's `hearth.devUser` header, plus the session cookie. A meeting with attendees starting within 90 s gets a notification once per event and start time (the web push rule), "Take notes for “<title>”?"; clicking it opens `/meetings/start?event=<id>` in the window. No server change; a member who also turned on web push reminders in a browser gets both. Off in Settings. `status.remindersLastStatus`, `status.remindersLastChecked`, `status.remindersLastPosted` and `status.notificationAuthorization` are written to the app's defaults for diagnosis.

Brand: `DictateCore/Brand.swift` holds the display name (`Hearth`), accent, URL scheme and rail shortcuts; the build script reads the name and scheme from it. The server has no brand endpoint. Strings that existed before 0.2.0 ("Hearth Dictate" for the dictation feature) are unchanged, except where they name the app in System Settings.

`HearthDictate --self-test <server> <folder> [--sign-in-dev <email>] [--remind] [--try-google]` drives the real suite window (shown on screen, since WebKit doesn't paint a hidden one) and writes `result.json` and PNG snapshots: storage and a cookie left by the previous run, an in-place route change, the reminders' API call and planner, Start opened from a reminder, a deep link, the media APIs the page sees, and Google's sign-in page. Run it from the installed app, with the app quit.

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

## 11. Organizations: setup, brand kit, bring-your-own keys (Hotsauce)

One instance serves one organization. Everything an organization chooses lives under `<DATA_DIR>/org/` on the volume, and the real environment always wins over it, so an instance configured entirely by env behaves exactly as it would without the wizard.

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
