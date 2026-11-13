// The install guide, install.sh, llms.txt and the landing page's install section
// (docs/PLAN-one-click-install.md). They must agree with each other and with the repository, so an
// agent following install.md does what a person clicking through the site does.
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

const guide = read('site/public/install.md')
const page = read('site/public/index.html')
const readme = read('README.md')
const selfHost = read('docs/self-host.md')
const llms = read('site/public/llms.txt')
const script = join(root, 'site/public/install.sh')

const PROMPT =
  'Install Hotsauce for my company by following https://hotsauce.work/install.md. Ask me before anything that needs my accounts, payment or DNS.'
const BUTTON =
  'https://deploy.workers.cloudflare.com/?url=https://github.com/hotsauce-suite/hotsauce'

describe('install.md', () => {
  it('gives the same agent prompt as the landing page, README and self-host guide (6)', () => {
    for (const doc of [guide, page, readme, selfHost]) expect(doc).toContain(PROMPT)
  })

  it('covers every host the landing page offers, with the same button and commands (2)', () => {
    for (const doc of [guide, page, readme]) {
      expect(doc).toContain(BUTTON)
      expect(doc).toContain('scripts/deploy-fly.sh')
      expect(doc).toContain('curl -fsSL https://hotsauce.work/install.sh |')
    }
  })

  it('names every setting the Deploy button asks for, as package.json names them (4)', () => {
    const bindings = Object.keys(JSON.parse(read('package.json')).cloudflare.bindings)
    const wrangler = read('wrangler.jsonc')
    // The Durable Object is the server itself; the button doesn't ask about it.
    const asked = bindings.filter((b) => !new RegExp(`"name":\\s*"${b}"`).test(wrangler))
    expect(asked.sort()).toEqual(['HOTSAUCE_MASTER_KEY', 'HOTSAUCE_SETUP_TOKEN', 'STATE'])
    for (const b of asked) expect(guide).toContain(`\`${b}\``)
    // The wrangler path renames exactly the two names the root config has.
    expect(wrangler).toContain('"name": "hotsauce"')
    expect(wrangler).toContain('"bucket_name": "hotsauce"')
  })

  it('marks human-only steps and tells the agent to stop at each (3)', () => {
    const steps = guide.match(/`HUMAN:`/g) ?? []
    expect(steps.length).toBeGreaterThanOrEqual(10)
    expect(guide).toMatch(/Stop at each one/)
    expect(guide).toMatch(/Never sign up, pay or create keys on their behalf/)
    // Each sign-up a person needs has its link.
    for (const link of [
      'https://dash.cloudflare.com/sign-up',
      'https://fly.io/app/sign-up',
      'https://dashboard.clerk.com/sign-up',
      'https://console.anthropic.com/settings/keys',
    ]) {
      expect(guide).toContain(link)
    }
  })

  it('ends with checks against /api/health (5)', () => {
    const checks = guide.slice(guide.indexOf('## 4. Check it worked'))
    expect(checks).toContain('/api/health')
    expect(checks).toContain('"ok":true')
    expect(checks).toContain('"setupRequired":true')
    expect(checks).toContain('"version"')
  })
})

describe('llms.txt (7)', () => {
  it('has a title, a summary and links to the install guide', () => {
    const lines = llms.split('\n')
    expect(lines[0]).toBe('# Hotsauce')
    expect(lines.find((l) => l.startsWith('> '))).toBeTruthy()
    expect(llms).toContain('](https://hotsauce.work/install.md)')
    expect(llms).toMatch(/^## /m)
  })
})

describe('the landing page install section (11)', () => {
  it('offers Cloudflare, the agent, Fly.io and Docker, in that order, Cloudflare first', () => {
    const tabs = [...page.matchAll(/data-host="([a-z]+)"/g)].map((m) => m[1])
    expect(tabs).toEqual(['cloudflare', 'agent', 'fly', 'docker'])
    expect(page).toMatch(/aria-selected="true" data-host="cloudflare"/)
    for (const t of tabs.slice(1)) expect(page).toMatch(new RegExp(`id="p-${t}"[^>]*hidden`))
    expect(page).not.toMatch(/id="p-cloudflare"[^>]*hidden/)
  })

  it('gives every command and the prompt a copy button, and links the hero to the agent', () => {
    const boxes = page.match(/<div class="cmd[^"]*">[\s\S]*?<\/div>/g) ?? []
    expect(boxes.length).toBeGreaterThanOrEqual(3)
    for (const b of boxes) expect(b).toContain('class="copy"')
    expect(page).toContain('data-pick-host="agent"')
  })
})

describe('install.sh', () => {
  it('is POSIX sh (8)', () => {
    execFileSync('sh', ['-n', script])
    const shellcheck = spawnSync('shellcheck', ['--version'])
    if (shellcheck.status === 0) execFileSync('shellcheck', ['-s', 'sh', script])
  })

  /** Runs install.sh with fake docker and curl that log what they were asked and answer `health`. */
  function run({
    env = {},
    health = '{"ok":true,"version":"9.9.9","setupRequired":true}',
    docker = true,
  } = {}) {
    const tmp = mkdtempSync(join(tmpdir(), 'hotsauce-install-'))
    const bin = join(tmp, 'bin')
    const dir = join(tmp, 'hotsauce')
    const log = join(tmp, 'calls.log')
    execFileSync('mkdir', ['-p', bin])
    const fake = (name, body) => {
      writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`)
      chmodSync(join(bin, name), 0o755)
    }
    if (docker) {
      fake(
        'docker',
        `case "$*" in *" logs "*) echo "hotsauce-1  |     https://hotsauce.acme.com/setup#token=abc_DEF-123" ;; esac`,
      )
    }
    fake('curl', `printf '%s' '${health}'`)
    fake('hostname', 'echo 10.0.0.5 172.17.0.1')
    fake('sleep', 'true')
    const res = spawnSync('/bin/sh', [script], {
      // Without Docker, PATH is only the fakes: this machine may have a real docker in /usr/bin.
      env: { PATH: docker ? `${bin}:/usr/bin:/bin` : bin, HOTSAUCE_DIR: dir, ...env },
      encoding: 'utf8',
    })
    const file = (n) => {
      try {
        return readFileSync(join(dir, n), 'utf8')
      } catch {
        return ''
      }
    }
    let calls = ''
    try {
      calls = readFileSync(log, 'utf8')
    } catch {}
    return {
      ...res,
      out: res.stdout + res.stderr,
      compose: file('compose.yml'),
      env: file('.env'),
      calls,
    }
  }

  it('refuses to run without Docker (8)', () => {
    const r = run({ docker: false })
    expect(r.status).not.toBe(0)
    expect(r.out).toContain("Docker isn't installed")
  })

  it('without a domain, serves on port 3000 at the server address and prints the setup link (9, 10)', () => {
    const r = run()
    expect(r.status, r.out).toBe(0)
    expect(r.env).toContain('PUBLIC_URL=http://10.0.0.5:3000')
    expect(r.compose).toContain('"3000:3000"')
    expect(r.compose).not.toContain('caddy')
    expect(r.calls).toMatch(/docker compose .* pull/)
    expect(r.calls).toMatch(/docker compose .* up -d/)
    expect(r.out).toContain('Hotsauce 9.9.9 is running at http://10.0.0.5:3000')
    expect(r.out).toContain('https://hotsauce.acme.com/setup#token=abc_DEF-123')
    expect(r.out).toContain('put it behind HTTPS')
  })

  it('with a domain, puts Caddy in front and keeps the server off the public interface (9)', () => {
    const r = run({ env: { HOTSAUCE_DOMAIN: 'hotsauce.acme.com' } })
    expect(r.status, r.out).toBe(0)
    expect(r.env).toContain('PUBLIC_URL=https://hotsauce.acme.com')
    expect(r.env).toContain('HOTSAUCE_DOMAIN=hotsauce.acme.com')
    expect(r.compose).toContain('"127.0.0.1:3000:3000"')
    expect(r.compose).toContain('image: caddy:2')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose fills it in from .env.
    expect(r.compose).toContain('--from ${HOTSAUCE_DOMAIN} --to hotsauce:3000')
    expect(r.compose).toContain('"443:443"')
    expect(r.out).not.toContain('put it behind HTTPS')
  })

  it('rejects a domain that is not a plain host name', () => {
    const r = run({ env: { HOTSAUCE_DOMAIN: 'acme.com; rm -rf /' } })
    expect(r.status).not.toBe(0)
    expect(r.calls).not.toContain('up -d')
  })

  it('holds no secrets and keeps the data volume, so running it again is safe (8)', () => {
    const r = run()
    expect(r.env).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD/)
    expect(r.compose).toContain('hotsauce-data:/data')
    expect(r.calls).not.toMatch(/volume rm|down -v/)
  })

  it('says so when the instance is already set up', () => {
    const r = run({ health: '{"ok":true,"version":"9.9.9","setupRequired":false}' })
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain("It's already set up")
    expect(r.out).not.toContain('setup#token')
  })

  it('gives up with a pointer to the logs when the server never answers (10)', () => {
    const r = run({ health: '', env: { HOTSAUCE_WAIT: '6' } })
    expect(r.status).not.toBe(0)
    expect(r.out).toContain("didn't answer within 6s")
    expect(r.out).toContain('logs hotsauce')
  })
})
