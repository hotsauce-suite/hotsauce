# Install Hotsauce

Hotsauce is an open-source office suite (docs, AI meeting notes, tasks, files, whiteboards,
dictation, screen recordings) that one organization runs on one small server it owns. This guide
installs it end to end. It is written so a coding agent can follow it for a person, and a person
can follow it alone.

Source: https://github.com/hotsauce-suite/hotsauce (AGPL-3.0). Longer guide:
https://github.com/hotsauce-suite/hotsauce/blob/main/docs/self-host.md

To have an agent do it, give the agent this prompt:

```text
Install Hotsauce for my company by following https://hotsauce.work/install.md. Ask me before anything that needs my accounts, payment or DNS.
```

## Rules for agents

- Steps marked `HUMAN:` need the person: signing up, paying, signing in to a website, creating
  keys, or changing DNS. Stop at each one, tell the person exactly what to do with the link given,
  and wait for them to say it's done. Never sign up, pay or create keys on their behalf.
- Ask the person for any value you need. Use the answers below as defaults only if they say "you
  choose".
- Never print, log or commit a secret after the person has it. When you generate one (the setup
  password or the master key), show it to the person once and tell them to keep a copy somewhere
  safe, such as their password manager.
- Finish with the checks in "Check it worked". Don't call it done until they pass.

## 1. Ask the person three things

1. **Where should it run?** Pick one host:
   - **Cloudflare**: about $13 to $15 a month, always on, no server to look after. Needs a
     Cloudflare account on Workers Paid and a GitHub account. The default for most teams.
   - **Fly.io**: about $6 a month. Needs a Fly.io account and a computer with a terminal.
   - **Docker on your own server**: any Linux server with Docker and about 1 GB of free memory.
2. **What is the organization called?** For example `Acme`. Used for app and bucket names, so make
   a short lowercase name from it too, such as `acme-hotsauce`.
3. **Which address?** Recommend `hotsauce.` on the company's domain, such as
   `https://hotsauce.acme.com`. The host's free address (`*.workers.dev` or `*.fly.dev`) works too,
   and the company domain can be added later.

Then follow the section for that host.

## 2a. Cloudflare

There are two ways. Use **the button** when you can't run commands for the person. Use **wrangler**
when you have a terminal with Node 22, git and Docker running.

**First, either way:**

1. `HUMAN:` Sign in to Cloudflare, or sign up at https://dash.cloudflare.com/sign-up
2. `HUMAN:` Switch the account to Workers Paid ($5 a month), which containers need:
   https://dash.cloudflare.com/?to=/:account/workers/plans
3. `HUMAN:` Turn on R2 storage if it isn't on yet (free up to 10 GB, needs a payment method on
   file): https://dash.cloudflare.com/?to=/:account/r2/overview

### With the button

1. Generate two secrets for the person and give them both:
   - a **setup password** of at least 12 characters, for example from
     `openssl rand -base64 18 | tr -d '/+='`
   - a **master key**, a long random string, for example from `openssl rand -base64 32`
2. `HUMAN:` Open https://deploy.workers.cloudflare.com/?url=https://github.com/hotsauce-suite/hotsauce
   and sign in with GitHub when it asks (Cloudflare copies Hotsauce into the person's GitHub).
   Fill in:
   - **Project name**: the short name, such as `acme-hotsauce`.
   - `STATE` (R2 bucket): choose **Create new**, named like the project.
   - `HOTSAUCE_SETUP_TOKEN`: the setup password.
   - `HOTSAUCE_MASTER_KEY`: the master key.
   Then click **Create and deploy**. The first build takes about ten minutes.
3. Ask the person for the address it shows when the build finishes, like
   `https://acme-hotsauce.<their-subdomain>.workers.dev`. That is `<url>` below.

### With wrangler

```sh
git clone --depth 1 https://github.com/hotsauce-suite/hotsauce && cd hotsauce
npx wrangler@4 login                       # HUMAN: approve in the browser window it opens
```

Pick the short name (`acme-hotsauce` below) and give the Worker and its bucket that name, then
create the bucket and deploy. Docker must be running: wrangler builds the server's image.

```sh
name=acme-hotsauce
sed -i.bak -e "s/\"name\": \"hotsauce\"/\"name\": \"$name\"/" \
  -e "s/\"bucket_name\": \"hotsauce\"/\"bucket_name\": \"$name\"/" wrangler.jsonc
npx wrangler@4 r2 bucket create "$name"
npx wrangler@4 deploy
```

The deploy prints the address, like `https://acme-hotsauce.<subdomain>.workers.dev`. That is
`<url>` below. Now generate and set the two secrets, without echoing them anywhere else:

```sh
setup_password="$(openssl rand -base64 18 | tr -d '/+=')"
openssl rand -base64 32 | npx wrangler@4 secret put HOTSAUCE_MASTER_KEY
printf '%s' "$setup_password" | npx wrangler@4 secret put HOTSAUCE_SETUP_TOKEN
```

Show the person `$setup_password` once and tell them to keep it until setup is finished. The
master key never needs to be seen again; it lives only in the Worker's secrets.

### Then, either way

1. Open `<url>/api/health`. The first visit starts the server, which takes one to three minutes;
   retry until it answers `"ok":true`.
2. `HUMAN:` Open `<url>/setup` and paste the setup password. Continue with "The setup wizard"
   below. On Cloudflare the server's disk is wiped whenever it restarts, so in the wizard's
   **Files and audio** step the documents must go in a **GitHub organization** (it needs a GitHub
   organization and a fine-grained token with Contents read and write on it), and Clips videos in
   **R2**.
3. For a company address: `HUMAN:` in Cloudflare, open the Worker, then **Settings → Domains &
   Routes → Add → Custom domain**, and enter it (the domain's DNS must be on Cloudflare). Then add
   the variable `PUBLIC_URL` with that address under **Settings → Variables and Secrets** and deploy
   again.

## 2b. Fly.io

Needs Node 22, git, pnpm (`corepack enable`) and flyctl (https://fly.io/docs/flyctl/install/).

1. `HUMAN:` Sign up or sign in at https://fly.io/app/sign-up and add a payment method.
2. Run, with the short name:

```sh
fly auth login                              # HUMAN: approve in the browser window it opens
git clone --depth 1 https://github.com/hotsauce-suite/hotsauce && cd hotsauce
corepack enable && pnpm install
scripts/deploy-fly.sh acme-hotsauce         # optional second argument: a region, default ewr
```

For a company address, run the last line as
`PUBLIC_URL=https://hotsauce.acme.com scripts/deploy-fly.sh acme-hotsauce` instead. It prints a DNS
record: `HUMAN:` add it at the domain's DNS provider (on Cloudflare, set it to DNS only, the grey
cloud).

The script creates the app and its disk, generates the server's keys as Fly secrets, deploys, and
prints the setup link. `<url>` is `https://acme-hotsauce.fly.dev` or the company address. If the
setup link isn't printed, run `fly logs --app acme-hotsauce --no-tail | grep setup`.

## 2c. Docker on your own server

On the server (Linux with Docker and the Docker Compose plugin), as a user that can run `docker`:

```sh
curl -fsSL https://hotsauce.work/install.sh | sh
```

For a company address with HTTPS, point its DNS record (an `A` record to the server's IP address;
`HUMAN:` if you can't change DNS) at the server first, make sure ports 80 and 443 are open, then:

```sh
curl -fsSL https://hotsauce.work/install.sh | HOTSAUCE_DOMAIN=hotsauce.acme.com sh
```

It installs to `/opt/hotsauce` (set `HOTSAUCE_DIR` to change it), runs the published release with
Caddy in front for HTTPS when given a domain, waits for the server and prints the setup link.
Without a domain, `<url>` is `http://<server>:3000`; put it behind HTTPS before the team uses it.
Running it again updates to the newest release and keeps the data. Back up the `hotsauce-data`
Docker volume.

## 3. The setup wizard

`HUMAN:` The person opens the setup link (or `<url>/setup` and the setup password on Cloudflare)
and goes through six steps. Help with the accounts each one needs:

1. **Organization**: the name, the workspace name the team sees, the email domains that may sign
   in (such as `acme.com`), and the admins' emails.
2. **Brand**: logo, colors and fonts. Optional; skip it to finish sooner.
3. **Sign-in**: a free Clerk application with Google turned on. `HUMAN:` create it at
   https://dashboard.clerk.com/sign-up, turn on Google under **Configure → SSO connections**, and
   copy its publishable key and secret key from **Configure → API keys** into the wizard.
4. **AI and transcription** (optional): `HUMAN:` an Anthropic key from
   https://console.anthropic.com/settings/keys and a Deepgram key from https://console.deepgram.com/
   Each has a Test button. Without them Docs, Tasks, Files and the rest work; the AI features say
   they need a key.
5. **Files and audio**: on Fly.io and Docker, keep the defaults (the server's own disk). On
   Cloudflare, see 2a.
6. **Review and launch**: the server restarts with the settings, and the person signs in with
   Google.

## 4. Check it worked

Run these against `<url>`:

1. `curl -fsS <url>/api/health` answers JSON with `"ok":true` and a `"version"`, which should match
   the newest release at https://github.com/hotsauce-suite/hotsauce/releases/latest
2. Before the wizard is finished it has `"setupRequired":true`; afterwards `"setupRequired":false`.
3. `HUMAN:` The person opens `<url>`, signs in with Google, and sees **Today**. Creating a doc in
   **Docs** and finding it in search proves storage and the index work.

Then tell the person: share `<url>` with the team (only the email domains chosen in step 1 can sign
in), admins change anything later under **Settings → Organization**, and updates arrive as a weekly
pull request on Cloudflare and Fly, or by running the install command again on Docker.

## If something goes wrong

- **Cloudflare deploy fails with a containers error**: the account isn't on Workers Paid yet.
- **`/api/health` times out on Cloudflare**: the first start takes up to five minutes; check the
  Worker's logs in the Cloudflare dashboard.
- **The setup link says it isn't valid**: it works once. On Docker run
  `docker compose -f /opt/hotsauce/compose.yml logs hotsauce | grep setup` for the newest one; on
  Fly `fly logs --app <name> --no-tail | grep setup`.
- **Sign-in says the email isn't allowed**: add its domain, or the address, in
  **Settings → Organization**.
- Anything else: https://github.com/hotsauce-suite/hotsauce/issues
