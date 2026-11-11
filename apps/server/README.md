# @hearth/server

The Hearth server: one Node process (Hono) serving the API, WebSockets, and the built web app. See
`docs/ARCHITECTURE.md` §3 for the module contract. Needs the real `git` CLI on `PATH` (2.30+).

## Running

```sh
pnpm build:format && pnpm --filter @hearth/server dev    # dev auth, local host, data in .data/, port 3000
pnpm --filter @hearth/server build && pnpm --filter @hearth/server start   # the built server (NODE_ENV defaults to production)
pnpm --filter @hearth/server reindex [space]             # rebuild the index from the clones (keeps recents, stars)
```

On start the server loads the repo-root `.env.local` if there is one, ensures the `team` space,
rebuilds the spaces table from each clone's `.hearth/space.yaml`, reloads meeting sessions left
unsaved by the last run, starts the poller, and serves the API under `/api`, WebSockets at `/ws`
and `/ws/meetings/:id`, and `apps/web/dist` for everything else (a placeholder page if the web
app isn't built). In dev mode, requests authenticate with the `x-hearth-dev-user: <email>` header:

```sh
curl -H 'x-hearth-dev-user: you@example.com' localhost:3000/api/me
```

Code layout: `app.ts` builds the API from injected services (`createApp`), `api/` holds the routes
grouped by resource, `sync/` the Syncer, Poller and WebSocket Broadcaster, `meetings/` Hearth
Meetings (below), `services.ts` wires the real services from config for `main.ts` and the CLI.

## Meetings

`docs/ARCHITECTURE.md` §7 is the contract. In `src/meetings/`: `transcriber/` (the `Transcriber`
interface, a deterministic fake, Deepgram), `llm/` (the `LLM` interface, a fake, Anthropic),
`templates/` (the seven built-in templates as markdown; the build copies them into `dist/`) and
`templates.ts`, `sessions.ts` + `session-store.ts` (recording sessions, on disk under
`DATA_DIR/sessions/<id>/` so a restart loses nothing), `socket.ts` (the `/ws/meetings/:id`
protocol), `files.ts` (the note, transcript and raw notes written on stop), `enhance/`, `chat.ts`,
`list.ts`, and `calendar/` (a fake, Google via Clerk).

Paid services are off unless configured. In development and test the transcriber, the language
model and (with dev auth) the calendar are fakes, so the whole flow runs offline; production
refuses the fakes and needs the keys:

| Variable | Default | |
| --- | --- | --- |
| `ASR_PROVIDER` | `fake`; `deepgram` in production | `deepgram` needs `DEEPGRAM_API_KEY` |
| `LLM_PROVIDER` | `fake`; `anthropic` in production | `anthropic` needs `ANTHROPIC_API_KEY` |
| `ENHANCE_MODEL` | `claude-sonnet-5-5` | |
| `CHAT_MODEL` | `claude-opus-5-5` | |
| `DICTATION_MODEL` | `claude-haiku-5-5` | Hearth Dictate's cleanup pass; runs on every dictation, so a fast model. |
| `KEEP_AUDIO` | `false` | whether Stop keeps the audio when the client doesn't say |
| `AUDIO_STORE` | `r2` if the `R2_*` keys are set, else `local` (dev/test) or `none` (production) | where kept audio goes; `none` hides Keep audio |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | | the Cloudflare R2 bucket for kept audio |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | | web push keys for meeting reminders (`npx web-push generate-vapid-keys`); reminders are off without them |
| `VAPID_SUBJECT` | `mailto:hearth@example.com` | the contact push services see |
| `SESSION_IDLE_STOP_MINUTES` | `120` | a session with no socket for longer is stopped and saved by the server |
| `SESSION_MAX_HOURS` | `8` | a session older than this is stopped and saved, connected or not |

Sessions don't outlive their usefulness: once saved, memory keeps only where a meeting was saved.
Every minute (and once at startup, in `recover()`) the server stops and saves, exactly as the
owner's Stop would, any session past either limit, so a tab that died never records forever or
holds a paid transcriber open. After a restart, idle time counts from when the session's files
were last written.

With `AUTH_MODE=clerk` the calendar is the member's Google Calendar, read with the OAuth token Clerk
holds (`clerk.users.getUserOauthAccessToken(userId, 'google')`); the Clerk Google connection needs
the `calendar.readonly` scope. Tests never call Deepgram, Anthropic or Google: Deepgram is tested
against recorded-shape fixtures (`test/fixtures/deepgram/`) and a local fake server, Anthropic
with an injected client, Google with an injected fetch and fixtures (`test/fixtures/google/`).
`createServices(config, { transcriber, llm, calendar })` takes stand-ins.

To watch a meeting go through by hand, start the dev server and drive it the way the browser
does: `POST /api/meetings/sessions`, open `/ws/meetings/<id>`, send `{"type":"auth","devUser":…}`,
then binary frames (byte 0 the track, 0 me or 1 them, then 16 kHz PCM16), `{"type":"notes",…}`,
and `POST /api/meetings/sessions/<id>/stop` (its optional `{ "notes": … }` replaces the raw notes
first; notes sent after the stop began are refused with 409). The note lands in
`.data/repos/<handle>/meetings/`. `POST /api/meetings/enhance` with `{ space, path }` then rewrites
it. `GET /api/meetings/sessions` lists the caller's own unsaved sessions, newest first.

## Tests

```sh
pnpm --filter @hearth/server exec vitest run                                          # unit (server-unit)
pnpm --filter @hearth/server exec vitest run --config vitest.integration.config.ts    # integration (server-integration)
```

From the repo root, `pnpm test:unit` and `pnpm test:integration` select the same projects by name.

### Without Forgejo (default)

Nothing to set up. Integration tests use temp directories, with `LocalHost` bare repositories as
`file://` remotes: no Docker, no network. The host suite (`test/integration/hosts.test.ts`) runs
against `LocalHost` and prints a skip line for each remote host that isn't configured.

### With Forgejo

The Forgejo adapter is tested against a real Forgejo in Docker (`docker-compose.yml` at the repo
root, http://localhost:3300):

```sh
scripts/forgejo-init.sh        # starts the container, creates the admin user, writes .data/forgejo-token
FORGEJO_URL=http://localhost:3300 FORGEJO_TOKEN="$(cat .data/forgejo-token)" \
  pnpm --filter @hearth/server exec vitest run --config vitest.integration.config.ts
```

- `FORGEJO_ORG` (default `hearth-test`) is the organization the tests create repositories in; it is
  created if missing. Every test repository is deleted afterwards.
- The webhook test has Forgejo deliver a real push event to a listener on this machine, reached as
  `host.docker.internal`. If your Docker setup names the host differently (for example a CI service
  container), set `FORGEJO_WEBHOOK_HOST`.
- The init script is safe to re-run; each run mints a new token. Stop Forgejo with
  `docker compose stop forgejo`; its data lives in the `hearth_forgejo-data` volume.

### With GitHub

Host tests run against GitHub only when both `GITHUB_TOKEN` and `GITHUB_TEST_ORG` are set. They
create and delete real private repositories in that organization, so use a throwaway org.
`GITHUB_TEST_COLLABORATOR` (a GitHub username) additionally enables the collaborator test.

## Running the server against a host

`HOST_KIND` picks the adapter (`apps/server/src/config.ts`):

- `local` (default): bare repositories under `LOCAL_HOST_DIR` (default `.data/remotes`).
- `forgejo`: `FORGEJO_URL`, `FORGEJO_TOKEN`, `FORGEJO_ORG`. For local dev, the values from
  `scripts/forgejo-init.sh` work; Forgejo can deliver webhooks to a server on the host at
  `http://host.docker.internal:3000/api/webhooks/git`.
- `github`: `GITHUB_TOKEN`, `GITHUB_ORG`.

Working clones live in `DATA_DIR/repos/<space>`. They are a cache of the remote: deleting one and
restarting re-clones it, conflict branches included.
