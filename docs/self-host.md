# Run Hotsauce for your organization

Hotsauce is one small server: a Node process, a folder of git repositories and a SQLite index on one disk. It needs about 1 GB of memory. Two ways to run it:

## Fly.io (about $6 a month)

1. Install [flyctl](https://fly.io/docs/flyctl/install/) and sign in with `fly auth login`.
2. From a clone of this repository:

   ```sh
   pnpm install
   scripts/deploy-fly.sh acme-office            # your app name; optional region, default ewr
   ```

   It creates the app and a 3 GB volume, generates the encryption and push keys as Fly secrets, deploys, and prints your setup link. To use your own domain, set `PUBLIC_URL=https://office.acme.com` before running it and follow `fly certs add office.acme.com`.
3. Open the setup link and follow the wizard.

## Docker on your own server

```sh
cd deploy
PUBLIC_URL=https://office.acme.com docker compose up -d --build
docker compose logs hotsauce | grep setup
```

Put it behind a reverse proxy that terminates HTTPS and passes WebSockets through (Caddy does both with `reverse_proxy localhost:3000`). Back up the `hotsauce-data` volume.

## The setup wizard

The link works only while the instance is new. It walks you through:

1. **Organization**: your name, the workspace name your team sees, the email domains that may sign in, and the admins.
2. **Brand**: logo, icon, colors, fonts and default look, with a live preview. Optional.
3. **Sign-in**: a free [Clerk](https://clerk.com) application with Google turned on. Paste its two keys.
4. **AI and transcription**: your own [Anthropic](https://console.anthropic.com/settings/keys) and [Deepgram](https://console.deepgram.com/) keys, each with a Test button. Optional; without them Docs works fully and the AI features say they need a key.
5. **Files and audio**: repositories on the server's disk, or in a GitHub organization; meeting audio in a Cloudflare R2 bucket, optional.
6. **Review and launch**: the server restarts with your settings and you sign in.

Admins change any of it later in **Settings → Organization**. Keys are stored encrypted on the volume and are never shown again.

## Configuring by environment instead

Every setting can also come from the environment, which always wins over the wizard. That suits infrastructure-as-code. The variables are in `apps/server/src/config.ts`; the ones the wizard covers are `ORG_NAME`, `PRODUCT_NAME`, `ALLOWED_EMAIL_DOMAINS`, `ADMIN_EMAILS`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `HOST_KIND`, `GITHUB_ORG`, `GITHUB_TOKEN`, `WEBHOOK_SECRET`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `KEEP_AUDIO` and `CHAT_URL`. With `CLERK_SECRET_KEY` set, the wizard never appears.
