# Run Hotsauce for your organization

Hotsauce is one small server: a Node process, a folder of git repositories and a SQLite index on one disk. It needs about 1 GB of memory. Three ways to run it:

## Fly.io (about $6 a month)

1. Install [flyctl](https://fly.io/docs/flyctl/install/) and sign in with `fly auth login`.
2. From a clone of this repository:

   ```sh
   pnpm install
   scripts/deploy-fly.sh acme-office            # your app name; optional region, default ewr
   ```

   It creates the app and a 3 GB volume, generates the encryption and push keys as Fly secrets, deploys, and prints your setup link. To use your own domain, set `PUBLIC_URL=https://office.acme.com` before running it and follow `fly certs add office.acme.com`.
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

From then on, every push to your copy's main branch deploys again (Workers Builds). The container stays on; a cron trigger restarts it within five minutes if it stops. To let it sleep when nobody uses it (cheaper; the first visit afterwards waits for it to start), add the variable `HOTSAUCE_SLEEP=true` to the Worker. To use your own domain, add it to the Worker under **Settings → Domains & Routes** and set the variable `PUBLIC_URL=https://office.acme.com`.

Known limits: a meeting that is recording when the container restarts keeps its transcript but not the audio recorded so far. The Chrome extension offered for download is built for `localhost`; build it for your address with `HEARTH_URL=https://… pnpm --filter @hearth/extension run build`.

## Docker on your own server

```sh
cd deploy
PUBLIC_URL=https://office.acme.com docker compose up -d --build
docker compose logs hotsauce | grep setup
```

Put it behind a reverse proxy that terminates HTTPS and passes WebSockets through (Caddy does both with `reverse_proxy localhost:3000`). Back up the `hotsauce-data` volume.

## Staying up to date

Every release is also a ready-made image, `ghcr.io/hotsauce-suite/hotsauce:<version>` (and `:latest`), which holds nothing specific to one organization: everything is read when the server starts. Docker hosts can run it as it is, and `/api/health` reports the version running. A built-in updater in Settings → Organization is coming (`docs/PLAN-releases-and-updates.md`).

Copies made from the repository keep working as below. Hotsauce's releases are tagged `vX.Y.Z`, and `HOTSAUCE_VERSION` in your copy says which one it has. The **Update Hotsauce** workflow (`.github/workflows/update-hotsauce.yml`) runs every Monday and from the Actions tab: it applies what changed between your release and the newest one, keeping your own edits, and opens a pull request. Merging it deploys:

- **Cloudflare:** Workers Builds deploys every push to main.
- **Fly:** add the repository secret `FLY_API_TOKEN` (from `fly tokens create deploy`) and the variable `FLY_APP` with your app's name, and the **Deploy to Fly** workflow deploys every push to main.

If a release changes lines you changed too, it opens an issue instead of a pull request. Two things to do once in a new copy:

1. A copy made by the Deploy button has no `.github` folder: add `update-hotsauce.yml` (and `deploy-fly.yml` on Fly) from Hotsauce's repository.
2. In your repository's **Settings → Actions → General**, tick "Allow GitHub Actions to create and approve pull requests".

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

Send feedback (members report bugs and ideas from the app) is configured only by environment: `FEEDBACK_REPO` (`owner/name` of the GitHub repository that receives the issues) and the secret `FEEDBACK_GITHUB_TOKEN` (a fine-grained token with Issues read/write on that repository and nothing else). Without both, the feature is hidden. To get the project board, add the same kind of token, plus Projects read/write on the organization, as the Actions secret `FEEDBACK_PROJECT_TOKEN` and run the "Feedback board" workflow once with mode `setup`. The API can't create board views, so then open the new "Feedback" project, switch its view to Board layout and set Column by to "Feedback status". Each member's list of their own feedback is keyed by `WEBHOOK_SECRET`; changing it hides earlier items from their senders (the issues stay). `docs/feedback-routine.md` is the instructions for an optional daily Claude review of the board.
