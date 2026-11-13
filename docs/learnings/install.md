# Installing Hotsauce: the guide, the script and the install test

Learnings from making Hotsauce one-click and agent installable (`docs/PLAN-one-click-install.md`).

- **One guide, tested for agreement.** `site/public/install.md` is the source of truth; the README,
  the self-host guide and the landing page repeat its prompt, button URL and commands, and
  `site/install.test.js` fails when any of them drift. Change the prompt in all four at once.
- **The Deploy button's form comes from `package.json` → `cloudflare.bindings`.** The test reads
  those names, so renaming a secret or the bucket binding forces the guide to follow.
- **Serve the guide and script as text.** Workers static assets give `.sh` a download type; the
  site worker sets `text/plain` / `text/markdown`, `inline` and `no-cache` for `install.md`,
  `install.sh` and `llms.txt` so agents and `curl | sh` always read the newest copy.
- **install.sh needs no secrets.** The server makes its own master key on the data volume when
  `HOTSAUCE_MASTER_KEY` is unset, so the script's `.env` holds only the image, address and domain,
  and running it again is a safe update.
- **`caddy reverse-proxy --from <domain> --to hotsauce:3000` is all the HTTPS needed.** No
  Caddyfile; it proxies WebSockets by default. With Caddy in front, publish the server on
  `127.0.0.1:3000` only. `HOTSAUCE_DOMAIN=localhost` exercises the whole path locally (Caddy's
  internal CA, `curl -k`).
- **A rerun must remember the last run's settings.** The first install.sh rewrote `.env` from the
  current environment only, so "run it again to update" silently dropped the domain and Caddy and
  broke Clerk sign-in (its allowed origin is `PUBLIC_URL`). Unset settings now come from the last
  `.env`; `none` clears one.
- **`… | sudo VAR=x sh`, never `… | VAR=x sudo sh`.** sudo's env_reset drops variables written
  before it, so the second form installs with no domain and reports success.
- **Wrap a `curl | sh` script in `main(); main "$@"`** so a cut-off download runs nothing.
- **Cloudflare wrangler path:** a clone needs `pnpm install` before `wrangler deploy` (the Worker
  imports `@cloudflare/containers`); the Deploy button doesn't, Workers Builds installs. Deploy
  with `--secrets-file` so the cron can't start the container before its secrets exist. Variables
  set in the dashboard are deleted by the next deploy unless `--keep-vars`, so tell people to set
  `PUBLIC_URL` and `HOTSAUCE_SLEEP` as secrets. `wrangler delete` leaves the container application
  running and billing: delete it with `wrangler containers delete <id>` first. (The install test's
  `containers list --json` filter was written from the CLI's help, untested until its first run.)
- **Changing `PUBLIC_URL` keeps the setup token.** Rerunning with a domain recreates the container
  and the setup link keeps its token with the new address; the newest log line is the right one.
- **Testing a shell script with fakes:** put fake `docker`, `curl`, `hostname` and `sleep` first on
  `PATH` and call `/bin/sh` by absolute path (Node resolves the command with the child's `PATH`).
  For "Docker missing", make `PATH` only the fakes folder: CI machines have a real docker.
- **An unattended agent in CI gets a narrow tool list** (`--allowedTools` for WebFetch, curl,
  `sudo sh` and `docker compose`, not bare `docker`, which would let it skip the guide with a
  `docker run`), not a blanket permission skip. It also needs the person's answers up front in
  `--append-system-prompt`, since the guide tells it to ask.
- **Cloudflare test buckets can't be deleted while the server's state is in them.** The test adds
  a one-day expiry rule on teardown and deletes emptied `hs-test-*` buckets at the start of the next
  run, instead of listing and deleting objects.
