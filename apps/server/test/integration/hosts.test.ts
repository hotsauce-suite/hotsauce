import { createHmac } from 'node:crypto'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { GitStore } from '../../src/git/index.js'
import { ForgejoHost, GitHubHost, type HostAdapter, LocalHost } from '../../src/hosts/index.js'
import { ALICE, HEARTH, makeTempDir, removeDir } from '../helpers/git.js'
import { restClient, webhookReceiver, withTimeout } from '../helpers/hosts.js'

// The same suite runs against every adapter this environment can reach. LocalHost always;
// Forgejo with FORGEJO_URL + FORGEJO_TOKEN (scripts/forgejo-init.sh); GitHub only with
// GITHUB_TOKEN + GITHUB_TEST_ORG, since it creates and deletes real repositories.

interface HostCase {
  name: string
  host: HostAdapter
  /** How many webhooks on `repo` point at `url`. */
  hookCount: (repo: string, url: string) => Promise<number>
  /** Whether the host reports `repo` as private; null where privacy doesn't apply. */
  isPrivate: ((repo: string) => Promise<boolean>) | null
  /** A user that exists on the host (created if needed), and a check that it can push. */
  collaborator: {
    username: () => Promise<string>
    canPush: (repo: string, username: string) => Promise<boolean>
  } | null
  /** Host name the git host uses to reach this machine for real webhook deliveries, or null. */
  deliveryHost: string | null
  /** Headers the host would send for `body`, for hosts we can't receive real deliveries from. */
  signedHeaders: (body: string, secret: string) => Record<string, string>
  teardown: () => Promise<void>
}

const runId = ulid().toLowerCase()
const repoName = (suffix: string) => `t-${runId}-${suffix}`

function localCase(dir: string): HostCase {
  return {
    name: 'local',
    host: new LocalHost({ dir }),
    hookCount: async () => 0,
    isPrivate: null,
    collaborator: null,
    deliveryHost: null,
    signedHeaders: () => ({}),
    teardown: async () => {},
  }
}

function forgejoCase(url: string, token: string): HostCase {
  const org = process.env.FORGEJO_ORG ?? 'hearth-test'
  const api = restClient(`${url.replace(/\/+$/, '')}/api/v1`, { Authorization: `token ${token}` })
  const username = `u-${runId}`.slice(0, 39)
  let userCreated = false
  return {
    name: 'forgejo',
    host: new ForgejoHost({ url, token, org }),
    hookCount: async (repo, hookUrl) => {
      const res = await api('GET', `/repos/${org}/${repo}/hooks?limit=50`)
      const hooks = (await res.json()) as Array<{ config: { url: string } }>
      return hooks.filter((h) => h.config.url === hookUrl).length
    },
    isPrivate: async (repo) => {
      const res = await api('GET', `/repos/${org}/${repo}`)
      return ((await res.json()) as { private: boolean }).private
    },
    collaborator: {
      username: async () => {
        if (!userCreated) {
          const res = await api('POST', '/admin/users', {
            username,
            email: `${username}@localhost.test`,
            password: `pw-${runId}-Aa1!`,
            must_change_password: false,
          })
          if (!res.ok) throw new Error(`create user: ${res.status} ${await res.text()}`)
          userCreated = true
        }
        return username
      },
      canPush: async (repo, user) => {
        const res = await api('GET', `/repos/${org}/${repo}/collaborators/${user}/permission`)
        if (!res.ok) return false
        const { permission } = (await res.json()) as { permission: string }
        return permission === 'write' || permission === 'admin' || permission === 'owner'
      },
    },
    deliveryHost: process.env.FORGEJO_WEBHOOK_HOST ?? 'host.docker.internal',
    signedHeaders: (body, secret) => ({
      'X-Forgejo-Signature': createHmac('sha256', secret).update(body).digest('hex'),
      'X-Forgejo-Event': 'push',
    }),
    teardown: async () => {
      if (userCreated) await api('DELETE', `/admin/users/${username}?purge=true`)
    },
  }
}

function githubCase(token: string, org: string): HostCase {
  const api = restClient('https://api.github.com', {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'hearth-tests',
  })
  const collaborator = process.env.GITHUB_TEST_COLLABORATOR
  return {
    name: 'github',
    host: new GitHubHost({ org, credential: async () => token }),
    hookCount: async (repo, hookUrl) => {
      const res = await api('GET', `/repos/${org}/${repo}/hooks?per_page=100`)
      const hooks = (await res.json()) as Array<{ config: { url?: string } }>
      return hooks.filter((h) => h.config.url === hookUrl).length
    },
    isPrivate: async (repo) => {
      const res = await api('GET', `/repos/${org}/${repo}`)
      return ((await res.json()) as { private: boolean }).private
    },
    collaborator: collaborator
      ? {
          username: async () => collaborator,
          // An invitation is pending until accepted, so check the invitation list too.
          canPush: async (repo, user) => {
            const res = await api('GET', `/repos/${org}/${repo}/invitations`)
            const invites = (await res.json()) as Array<{ invitee: { login: string } }>
            return invites.some((i) => i.invitee.login.toLowerCase() === user.toLowerCase())
          },
        }
      : null,
    deliveryHost: null,
    signedHeaders: (body, secret) => ({
      'X-Hub-Signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
      'X-GitHub-Event': 'push',
    }),
    teardown: async () => {},
  }
}

const forgejoUrl = process.env.FORGEJO_URL
const forgejoToken = process.env.FORGEJO_TOKEN
const githubToken = process.env.GITHUB_TOKEN
const githubOrg = process.env.GITHUB_TEST_ORG

const skips: string[] = []
if (!(forgejoUrl && forgejoToken)) {
  skips.push('forgejo: set FORGEJO_URL and FORGEJO_TOKEN (see scripts/forgejo-init.sh)')
}
if (!(githubToken && githubOrg)) skips.push('github: set GITHUB_TOKEN and GITHUB_TEST_ORG')
for (const reason of skips) {
  console.warn(`[hosts.test] skipping ${reason}`)
  it.skip(`HostAdapter ${reason}`, () => {})
}

const factories: Array<[string, (root: string) => HostCase]> = [
  ['local', (root) => localCase(join(root, 'remotes'))],
]
if (forgejoUrl && forgejoToken)
  factories.push(['forgejo', () => forgejoCase(forgejoUrl, forgejoToken)])
if (githubToken && githubOrg) factories.push(['github', () => githubCase(githubToken, githubOrg)])

for (const [name, makeCase] of factories) {
  describe(`HostAdapter: ${name}`, () => {
    let root: string
    let c: HostCase
    const created = new Set<string>()

    async function ensure(suffix: string) {
      const repo = repoName(suffix)
      created.add(repo)
      return { repo, ...(await c.host.ensureRepo(repo)) }
    }

    beforeAll(async () => {
      root = await makeTempDir('hearth-hosts-')
      c = makeCase(root)
    })

    afterAll(async () => {
      for (const repo of created) await c.host.deleteRepo(repo)
      await c.teardown()
      await removeDir(root)
    })

    it('ensureRepo is idempotent and returns a URL git can clone, push, and fetch', async () => {
      const first = await ensure('roundtrip')
      const second = await c.host.ensureRepo(first.repo)
      expect(second.cloneUrl).toBe(first.cloneUrl)
      if (c.isPrivate) expect(await c.isPrivate(first.repo)).toBe(true)

      const writer = new GitStore({ dataDir: join(root, 'writer'), committer: HEARTH })
      await writer.ensureClone(first.repo, first.cloneUrl)
      expect(await writer.listAll(first.repo)).toEqual([])
      const result = await writer.commit(first.repo, {
        changes: [{ path: 'README.md', content: '# Round trip\n' }],
        author: ALICE,
        message: 'hearth: create space',
      })
      expect(result.status).toBe('committed')

      const reader = new GitStore({ dataDir: join(root, 'reader'), committer: HEARTH })
      await reader.ensureClone(first.repo, first.cloneUrl)
      expect(await reader.readFile(first.repo, 'README.md')).toMatchObject({
        content: '# Round trip\n',
      })
      expect(await reader.headOid(first.repo)).toBe(result.status === 'committed' && result.oid)
    })

    it('deleteRepo removes the repository; ensureRepo then recreates it empty', async () => {
      const { repo, cloneUrl } = await ensure('delete')
      const store = new GitStore({ dataDir: join(root, 'delete-1'), committer: HEARTH })
      await store.ensureClone(repo, cloneUrl)
      await store.commit(repo, {
        changes: [{ path: 'a.md', content: 'a\n' }],
        author: ALICE,
        message: 'add a',
      })

      await c.host.deleteRepo(repo)
      await c.host.deleteRepo(repo) // already gone: still fine

      const again = await c.host.ensureRepo(repo)
      const fresh = new GitStore({ dataDir: join(root, 'delete-2'), committer: HEARTH })
      await fresh.ensureClone(repo, again.cloneUrl)
      expect(await fresh.listAll(repo)).toEqual([])
    })

    it('refuses deleteRepo in production', async () => {
      vi.stubEnv('NODE_ENV', 'production')
      try {
        await expect(c.host.deleteRepo(repoName('never'))).rejects.toMatchObject({
          code: 'forbidden',
        })
      } finally {
        vi.unstubAllEnvs()
      }
    })

    it('ensureWebhook is idempotent', async () => {
      const { repo } = await ensure('hook')
      const url = 'http://hearth.invalid/api/webhooks/git'
      await c.host.ensureWebhook(repo, url, 'secret-1')
      await c.host.ensureWebhook(repo, url, 'secret-2')
      expect(await c.hookCount(repo, url)).toBe(name === 'local' ? 0 : 1)
    })

    it('parseWebhook accepts only correctly signed push events', async () => {
      const body = JSON.stringify({ ref: 'refs/heads/main', repository: { name: 'team' } })
      const headers = c.signedHeaders(body, 'right')
      if (name === 'local') {
        expect(c.host.parseWebhook(headers, body, 'right')).toBeNull()
        return
      }
      expect(c.host.parseWebhook(headers, body, 'right')).toEqual({
        repo: 'team',
        ref: 'refs/heads/main',
      })
      expect(c.host.parseWebhook(headers, body, 'wrong')).toBeNull()
      expect(c.host.parseWebhook(headers, `${body} `, 'right')).toBeNull()
    })

    it.runIf(name === 'forgejo')('verifies a real push delivery from the host', async () => {
      const deliveryHost = c.deliveryHost ?? 'host.docker.internal'
      const receiver = await webhookReceiver(deliveryHost)
      try {
        const { repo, cloneUrl } = await ensure('delivery')
        const secret = `secret-${runId}`
        await c.host.ensureWebhook(repo, receiver.url, secret)

        const store = new GitStore({ dataDir: join(root, 'delivery'), committer: HEARTH })
        await store.ensureClone(repo, cloneUrl)
        await store.commit(repo, {
          changes: [{ path: 'docs/a.md', content: 'a\n' }],
          author: ALICE,
          message: 'docs: create "a"',
        })

        const delivery = await withTimeout(receiver.first, 30_000, 'webhook delivery')
        expect(c.host.parseWebhook(delivery.headers, delivery.body, secret)).toEqual({
          repo,
          ref: 'refs/heads/main',
        })
        expect(c.host.parseWebhook(delivery.headers, delivery.body, 'not-the-secret')).toBeNull()
      } finally {
        await receiver.close()
      }
    })

    it('addCollaborator grants push access, idempotently', async () => {
      const { repo } = await ensure('collab')
      if (c.collaborator === null) {
        await expect(c.host.addCollaborator(repo, 'someone')).resolves.toBeUndefined()
        return
      }
      const username = await c.collaborator.username()
      await c.host.addCollaborator(repo, username)
      await c.host.addCollaborator(repo, username)
      expect(await c.collaborator.canPush(repo, username)).toBe(true)
    })
  })
}
