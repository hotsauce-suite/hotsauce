# Run Hotsauce for your organization

Hotsauce is one small server: a Node process, a folder of git repositories and a SQLite index on one disk. It needs about 1 GB of memory.

**Its address:** give it `hotsauce.` on your company's domain, like `https://hotsauce.acme.com`: one DNS record, and your team knows it's yours. Any other address works too. Three ways to run it, below.

**Have an agent do it.** [hotsauce.work/install.md](https://hotsauce.work/install.md) is the same install as a step-by-step guide written for coding agents: it covers all three hosts, marks the steps only a person can do (sign-ups, payment, sign-in keys, DNS) and ends with checks that prove it worked. Give an agent this prompt:

```text
Install Hotsauce for my company by following https://hotsauce.work/install.md. Ask me before anything that needs my accounts, payment or DNS.
```

The guide lives in this repository at `site/public/install.md`; change it with the install it describes. After every release the **Install test** workflow (`.github/workflows/install-test.yml`) installs Hotsauce from scratch with `install.sh`, again with a Claude agent given only that prompt, and on a test Cloudflare account.

## Fly.io (about $6 a month)

1. Install [flyctl](https://fly.io/docs/flyctl/install/) and sign in with `fly auth login`.
2. From a clone of this repository:

   ```sh
   pnpm install
   scripts/deploy-fly.sh acme-office            # your app name; optional region, default ewr
   ```

   It creates the app and a 3 GB volume, generates the encryption and push keys as Fly secrets, deploys, and prints your setup link. To give it your company's address, set `PUBLIC_URL=https://hotsauce.acme.com` before running it, then run `fly certs add hotsauce.acme.com --app acme-office` and add the DNS record it prints.
3. Open the setup link and follow the wizard.

## Cloudflare (about $13–15 a month, always on)

Hotsauce runs in a [Cloudflare Container](https://developers.cloudflare.com/containers/): the same Docker image, started by a small Worker (`apps/cloudflare/`, configured by the root `wrangler.jsonc`). Containers need the [Workers Paid plan](https://dash.cloudflare.com/?to=/:account/workers/plans) ($5 a month); the container itself adds about $8–10 for a small team.

A container's disk is wiped whenever it restarts, so on Cloudflare:

- Repositories live in a **GitHub organization** (the server clones them again when it starts).
- Clips videos and kept meeting audio go in **R2**.
- Everything else that can't be rebuilt (settings, encrypted keys, sign-in tokens, push subscriptions, Clips and Dictate records) is kept in the Worker's R2 bucket under `state/` by the server's state mirror, pushed every 15 seconds and when the server stops. Search rebuilds from git.

Steps:

1. Click **Deploy to Cloudflare** in the README. Cloudflare copies Hotsauce to your GitHub, asks for a Worker name, an R2 bucket, a **setup password** (`HOTSAUCE_SETUP_TOKEN`, at least 12 characters) and a **master key** (`HOTSAUCE_MASTER_KEY`, a long random string you keep somewhere safe), then builds and deploys. The first build takes several minutes.
2. Open `https://<worker>.<account>.workers.dev/setup` and paste your setup password. The first visit starts the server, which takes a minute or two.
3. In the wizard's **Files and audio** step, give it a GitHub organization and token, and R2 keys for video (the bucket the button made is fine).

From then on, every push to your copy's main branch deploys again (Workers Builds). The container stays on; a cron trigger restarts it within five minutes if it stops. To let it sleep when nobody uses it (cheaper; the first visit afterwards waits for it to start), add `HOTSAUCE_SLEEP=true` to the Worker as a secret. To use your own domain, add it to the Worker under **Settings → Domains & Routes** and set `PUBLIC_URL=https://hotsauce.acme.com` as a **secret** (a plain variable set in the dashboard is removed by the next deploy).

Known limits: a meeting that is recording when the container restarts keeps its transcript but not the audio recorded so far. The Chrome extension offered for download carries your server's address (`PUBLIC_URL`) and name.

## Docker on your own server

The quickest way, on any Linux server with Docker and the Compose plugin:

```sh
curl -fsSL https://hotsauce.work/install.sh | sudo sh                                     # http://<server>:3000
curl -fsSL https://hotsauce.work/install.sh | sudo HOTSAUCE_DOMAIN=hotsauce.acme.com sh   # with HTTPS
```

Settings go after `sudo`, which drops any written before it. It writes `compose.yml` to `/opt/hotsauce` (`HOTSAUCE_DIR` changes it), runs the newest release, adds Caddy in front for HTTPS when given a domain whose DNS points at the server (ports 80 and 443 open), checks HTTPS works, and prints the setup link. Without a domain it uses the server's first IP address; set `HOTSAUCE_URL=http://<public address>:3000` when that's a private one. Running it again with no settings updates to the newest release and keeps the domain and your data (`HOTSAUCE_DOMAIN=none` removes the domain). The script is `site/public/install.sh` in this repository.

Or by hand, from a clone:

```sh
cd deploy
PUBLIC_URL=https://hotsauce.acme.com docker compose up -d
docker compose logs hotsauce | grep setup
```

Put it behind a reverse proxy that terminates HTTPS and passes WebSockets through (Caddy does both with `reverse_proxy localhost:3000`). Back up the `hotsauce-data` volume.

## Staying up to date

Every release is also a ready-made image, `ghcr.io/hotsauce-suite/hotsauce:<version>` (and `:latest`), which holds nothing specific to one organization: everything is read when the server starts. Docker hosts can run it as it is, and `/api/health` reports the version running. On Fly.io with a `FLY_API_TOKEN`, **Settings → Organization → Updates** installs each new release within a few hours (never while a meeting is being recorded) and rolls back if the new version fails its health check; turn automatic updates off to update only when you press **Update** (`docs/PLAN-releases-and-updates.md`).

Copies made from the repository keep working as below. Hotsauce's releases are tagged `vX.Y.Z`, and `HOTSAUCE_VERSION` in your copy says which one it has. The **Update Hotsauce** workflow (`.github/workflows/update-hotsauce.yml`) runs every Monday and from the Actions tab: it applies what changed between your release and the newest one, keeping your own edits, and opens a pull request. Merging it deploys:

- **Cloudflare:** Workers Builds deploys every push to main.
- **Fly:** add the repository secret `FLY_API_TOKEN` (from `fly tokens create deploy`) and the variable `FLY_APP` with your app's name, and the **Deploy to Fly** workflow deploys every push to main.

If a release changes lines you changed too, it opens an issue instead of a pull request. Two things to do once in a new copy:

1. A copy made by the Deploy button has no `.github` folder: add `update-hotsauce.yml` (and `deploy-fly.yml` on Fly) from Hotsauce's repository.
2. In your repository's **Settings → Actions → General**, tick "Allow GitHub Actions to create and approve pull requests".

## Backups

With a storage bucket set up (Cloudflare R2 or any S3-compatible one), the server backs up its data volume to that bucket every night and keeps 14 daily and 8 weekly copies. **Settings → Organization → Backups** shows the last one and has a **Back up now** button.

To hear about a broken backup, point any uptime monitor (Better Stack, UptimeRobot, Healthchecks) at `https://<your address>/api/health/backup`. It answers 200 while backups are working and 503 when the newest one failed or none has worked for 26 hours. It never says why; the reason is in Settings and the server log.

## The setup wizard

The link works only while the instance is new. It walks you through:

1. **Organization**: your name, the workspace name your team sees, the email domains that may sign in, and the admins.
2. **Brand**: logo, icon, colors, fonts and default look, with a live preview. Optional.
3. **Sign-in**: a free [Clerk](https://clerk.com) application with Google turned on. Paste its two keys.
4. **AI and transcription**: your own [Anthropic](https://console.anthropic.com/settings/keys) and [Deepgram](https://console.deepgram.com/) keys, each with a Test button. Optional; without them Docs works fully and the AI features say they need a key.
5. **Files and audio**: repositories on the server's disk, or in a GitHub organization; Clips videos and kept meeting audio on the server's disk, or in a Cloudflare R2 bucket if you want more room.
6. **Review and launch**: the server restarts with your settings and you sign in.

Admins change any of it later in **Settings → Organization**. Keys are stored encrypted on the volume and are never shown again.

## Configuring by environment instead

Every setting can also come from the environment, which always wins over the wizard. That suits infrastructure-as-code. The variables are in `apps/server/src/config.ts`; the ones the wizard covers are `ORG_NAME`, `PRODUCT_NAME`, `ALLOWED_EMAIL_DOMAINS`, `ADMIN_EMAILS`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `HOST_KIND`, `GITHUB_ORG`, `GITHUB_TOKEN`, `WEBHOOK_SECRET`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `KEEP_AUDIO` and `CHAT_URL`. With `CLERK_SECRET_KEY` set, the wizard never appears.

The assistant (Ask, ⌘J) uses the Anthropic key and needs nothing else. Its model and monthly limit per member are set in Settings → Organization → Assistant, or by environment: `ASSISTANT_MODEL` (default `claude-sonnet-5-5`; `claude-opus-5-5` for harder questions) and `ASSISTANT_MONTHLY_LIMIT_USD` (an estimated dollar amount per member per month; empty or `0` for no limit). Conversations are kept in `assistant.sqlite` in the data directory, private to each member, and backed up with the rest of the server's data.

Send feedback (members report bugs and ideas from the app) is configured only by environment: `FEEDBACK_REPO` (`owner/name` of the GitHub repository that receives the issues) and the secret `FEEDBACK_GITHUB_TOKEN` (a fine-grained token with Issues read/write on that repository and nothing else). Without both, the feature is hidden. To get the project board, add the same kind of token, plus Projects read/write on the organization, as the Actions secret `FEEDBACK_PROJECT_TOKEN` and run the "Feedback board" workflow once with mode `setup`. The workflow runs on the issues' own events, so when `FEEDBACK_REPO` is not the code repository, copy `.github/workflows/feedback-board.yml` and `.github/scripts/feedback-board.mjs` into it and put the secret there. The API can't create board views, so then open the new "Feedback" project, switch its view to Board layout and set Column by to "Feedback status". Each member's list of their own feedback is keyed by `WEBHOOK_SECRET`; changing it hides earlier items from their senders (the issues stay). `docs/feedback-routine.md` is the instructions for an optional daily Claude review of the board.
