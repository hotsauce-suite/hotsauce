# Plan: one-click install, and an install an agent can do

**Goal.** Another company can get its own Hotsauce running with one click, or by handing one sentence
to its coding agent. Everything follows one install guide, `hotsauce.work/install.md`, so the
button, the agent prompt, the curl script and the README can't drift apart.

## Status

- 2026-11-13: plan written and built. Morgan said yes to the coordinator's three recommendations
  (Cloudflare for the button, the agent prompt on the landing page with a copy button, a fresh
  install by a test agent every release). He then said yes to Q1 to Q5: Docker and Cloudflare release
  tests, the prompt in the install section, Cloudflare first, no Railway or Render button yet,
  Caddy for HTTPS in install.sh.
- Owed by Morgan: the release test's repository secrets (`ANTHROPIC_API_KEY`,
  `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`). Until they're in, the agent and Cloudflare jobs
  fail with a warning naming the missing secrets (a red test is visible; a skipped one isn't);
  the scripted Docker install still runs.

## Shape

- `site/public/install.md`: the install guide, written for an agent to follow end to end and
  readable by a person. It picks a host, gives exact commands, marks every step only a human can
  do (sign-ups, payment, Google sign-in keys, DNS), and ends with checks that prove it worked.
- `site/public/llms.txt`: the short map of the site for language models, pointing at install.md.
- `site/public/install.sh`: `curl -fsSL https://hotsauce.work/install.sh | sh` installs the Docker
  path on a Linux server, with Caddy for HTTPS when given a domain, and prints the setup link.
- The landing page's install section offers, in order: Cloudflare (Deploy button), Ask your
  agent (the prompt with a copy button), Fly.io, Docker (the curl line).
- `.github/workflows/install-test.yml`: after every release, a scripted install with install.sh,
  then a Claude agent given only the landing page's prompt, on a fresh GitHub runner; and a
  Cloudflare deploy to a test account, torn down afterwards.

## Requirements

1. `hotsauce.work/install.md`, `/llms.txt` and `/install.sh` are served as UTF-8 text that curl and
   agents read inline (not as a download), with `cache-control: no-cache`.
2. install.md names every host the landing page offers (Cloudflare, Fly.io, Docker), and for each
   gives the exact commands or button URL that the README and the landing page use.
3. install.md marks each human-only step with the same marker (`HUMAN:`) and tells the agent to
   stop and ask at each one, never to sign up, pay or create keys on the person's behalf.
4. install.md lists the Cloudflare Deploy button's settings using the exact names in the root
   `package.json` `cloudflare.bindings`, so a renamed binding fails a test.
5. install.md ends with checks: `/api/health` answers `"ok":true` with the release's version, and
   `"setupRequired":true` until the wizard is done.
6. The agent prompt on the landing page, the one in install.md and the one in README are the same
   text.
7. llms.txt follows the llms.txt format (an H1, a one-line summary in a blockquote, link lists) and
   links install.md.
8. install.sh is POSIX sh (`sh -n` and shellcheck clean), refuses to run without Docker and Docker
   Compose, writes its files to one folder (default `/opt/hotsauce`), never handles a secret (the server keeps its own key on its volume),
   and is safe to run again (keeps the existing master key and data).
9. With `HOTSAUCE_DOMAIN` set, install.sh adds Caddy in front for HTTPS and sets `PUBLIC_URL` to
   `https://<domain>`; without it, the server listens on port 3000 with `http://<host>:3000`.
10. install.sh waits for `/api/health` and prints the setup link from the server's log.
11. The landing page's install section has four options in the order Cloudflare, Ask your agent,
    Fly.io, Docker; Cloudflare is selected first; every command and the prompt have a copy button;
    the hero links to the agent option.
12. After every release, the install test runs install.sh on a fresh runner and checks
    requirement 5 and the setup link; then, given `ANTHROPIC_API_KEY`, a Claude agent with only the
    landing page's prompt installs it again and the same checks run; and given the Cloudflare
    secrets, it deploys to a test account, checks `/api/health`, and deletes the Worker and bucket.
    A missing secret fails that job with a warning naming it, never a pass or skip that hides it.
13. README, docs/self-host.md and the landing page FAQ describe these paths and no longer say every
    install needs someone at a terminal.

## Tests

- `site/install.test.js` (vitest, project `site`): 2 to 9 and 11 by reading the files; 8 and 9 by
  running install.sh with fake `docker` and `curl` on `PATH`.
- `site/worker.test.js`: 1.
- `.github/workflows/install-test.yml`: 10 and 12 for real, on every release and by hand.
- Real browser: 11, the copy buttons and the tabs, light and dark, phone width.
