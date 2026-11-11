import { z } from 'zod'
import {
  assertNotProduction,
  assertRepoName,
  header,
  hostError,
  hostFetch,
  parsePushPayload,
  verifyHmacSha256Hex,
} from './shared.js'
import type { HostAdapter } from './types.js'

const API = 'https://api.github.com'
const Hook = z.object({
  id: z.number(),
  config: z.object({ url: z.string().optional() }).passthrough(),
})
const HookList = z.array(Hook)

/**
 * GitHub REST API, private repos in one organization. `credential` returns a token: a personal
 * access token now, a GitHub App installation token later, without changing this class.
 */
export class GitHubHost implements HostAdapter {
  readonly kind = 'github'
  private readonly org: string
  private readonly credential: () => Promise<string>

  constructor(opts: { org: string; credential: () => Promise<string> }) {
    assertRepoName(opts.org)
    this.org = opts.org
    this.credential = opts.credential
  }

  async ensureRepo(name: string): Promise<{ cloneUrl: string }> {
    assertRepoName(name)
    const existing = await this.request('GET', this.repoPath(name))
    if (existing.status === 404) {
      const created = await this.request('POST', `/orgs/${this.org}/repos`, {
        name,
        private: true,
        auto_init: false,
      })
      // 422 also covers "name already exists" (created concurrently); confirm before accepting it.
      const exists =
        created.ok ||
        (created.status === 422 && (await this.request('GET', this.repoPath(name))).ok)
      if (!exists) throw await hostError('GitHub', `create repo ${name}`, created)
    } else if (!existing.ok) {
      throw await hostError('GitHub', `get repo ${name}`, existing)
    }
    // The token is embedded for git; ensureClone re-sets the URL when a fresh token is needed.
    const url = new URL(`https://github.com/${this.org}/${name}.git`)
    url.username = 'x-access-token'
    url.password = await this.credential()
    return { cloneUrl: url.href }
  }

  async deleteRepo(name: string): Promise<void> {
    assertNotProduction('deleteRepo')
    assertRepoName(name)
    const res = await this.request('DELETE', this.repoPath(name))
    if (!res.ok && res.status !== 404) throw await hostError('GitHub', `delete repo ${name}`, res)
  }

  async ensureWebhook(name: string, url: string, secret: string): Promise<void> {
    assertRepoName(name)
    const list = await this.request('GET', `${this.repoPath(name)}/hooks?per_page=100`)
    if (!list.ok) throw await hostError('GitHub', `list hooks of ${name}`, list)
    const hooks = HookList.parse(await list.json())
    const existing = hooks.find((h) => h.config.url === url)
    const body = {
      active: true,
      events: ['push'],
      config: { url, content_type: 'json', secret, insecure_ssl: '0' },
    }
    // The secret can't be read back, so an existing hook is always re-saved with the current one.
    const res = existing
      ? await this.request('PATCH', `${this.repoPath(name)}/hooks/${existing.id}`, body)
      : await this.request('POST', `${this.repoPath(name)}/hooks`, { name: 'web', ...body })
    if (!res.ok) throw await hostError('GitHub', `save webhook on ${name}`, res)
  }

  parseWebhook(
    headers: Record<string, string>,
    rawBody: string,
    secret: string,
  ): { repo: string; ref: string } | null {
    const signature = header(headers, 'x-hub-signature-256')
    if (!signature?.startsWith('sha256=')) return null
    if (!verifyHmacSha256Hex(secret, rawBody, signature.slice('sha256='.length))) return null
    if (header(headers, 'x-github-event') !== 'push') return null
    return parsePushPayload(rawBody)
  }

  async addCollaborator(name: string, username: string): Promise<void> {
    assertRepoName(name)
    const path = `${this.repoPath(name)}/collaborators/${encodeURIComponent(username)}`
    // 201 sends an invitation; 204 means already a collaborator.
    const res = await this.request('PUT', path, { permission: 'push' })
    if (!res.ok) throw await hostError('GitHub', `add collaborator ${username} to ${name}`, res)
  }

  private repoPath(name: string): string {
    return `/repos/${this.org}/${name}`
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    return hostFetch('GitHub', `${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.credential()}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'hearth',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }
}
