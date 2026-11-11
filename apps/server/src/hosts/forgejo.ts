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

const Hook = z.object({ id: z.number(), config: z.object({ url: z.string() }).passthrough() })
const HookList = z.array(Hook)

/** Forgejo REST API v1, token auth, private repos in one organization (created if missing). */
export class ForgejoHost implements HostAdapter {
  readonly kind = 'forgejo'
  private readonly baseUrl: string
  private readonly token: string
  private readonly org: string
  private orgReady: Promise<void> | null = null

  constructor(opts: { url: string; token: string; org: string }) {
    this.baseUrl = opts.url.replace(/\/+$/, '')
    this.token = opts.token
    this.org = opts.org
    assertRepoName(opts.org)
  }

  async ensureRepo(name: string): Promise<{ cloneUrl: string }> {
    assertRepoName(name)
    await this.ensureOrg()
    const existing = await this.request('GET', this.repoPath(name))
    if (existing.status === 404) {
      const created = await this.request('POST', `/orgs/${this.org}/repos`, {
        name,
        private: true,
        auto_init: false,
        default_branch: 'main',
      })
      // 409: created concurrently by someone else, which is the state we wanted.
      if (!created.ok && created.status !== 409) {
        throw await hostError('Forgejo', `create repo ${name}`, created)
      }
    } else if (!existing.ok) {
      throw await hostError('Forgejo', `get repo ${name}`, existing)
    }
    return { cloneUrl: this.cloneUrl(name) }
  }

  async deleteRepo(name: string): Promise<void> {
    assertNotProduction('deleteRepo')
    assertRepoName(name)
    const res = await this.request('DELETE', this.repoPath(name))
    if (!res.ok && res.status !== 404) throw await hostError('Forgejo', `delete repo ${name}`, res)
  }

  async ensureWebhook(name: string, url: string, secret: string): Promise<void> {
    assertRepoName(name)
    const list = await this.request('GET', `${this.repoPath(name)}/hooks?limit=50`)
    if (!list.ok) throw await hostError('Forgejo', `list hooks of ${name}`, list)
    const hooks = HookList.parse(await list.json())
    const existing = hooks.find((h) => h.config.url === url)
    const body = {
      config: { url, content_type: 'json', secret },
      events: ['push'],
      active: true,
    }
    // The secret can't be read back, so an existing hook is always re-saved with the current one.
    const res = existing
      ? await this.request('PATCH', `${this.repoPath(name)}/hooks/${existing.id}`, body)
      : await this.request('POST', `${this.repoPath(name)}/hooks`, { type: 'forgejo', ...body })
    if (!res.ok) throw await hostError('Forgejo', `save webhook on ${name}`, res)
  }

  parseWebhook(
    headers: Record<string, string>,
    rawBody: string,
    secret: string,
  ): { repo: string; ref: string } | null {
    const signature = header(headers, 'x-forgejo-signature')
    if (!signature || !verifyHmacSha256Hex(secret, rawBody, signature)) return null
    if (header(headers, 'x-forgejo-event') !== 'push') return null
    return parsePushPayload(rawBody)
  }

  async addCollaborator(name: string, username: string): Promise<void> {
    assertRepoName(name)
    const path = `${this.repoPath(name)}/collaborators/${encodeURIComponent(username)}`
    const res = await this.request('PUT', path, { permission: 'write' })
    if (!res.ok) throw await hostError('Forgejo', `add collaborator ${username} to ${name}`, res)
  }

  private ensureOrg(): Promise<void> {
    this.orgReady ??= this.createOrgIfMissing().catch((err: unknown) => {
      this.orgReady = null
      throw err
    })
    return this.orgReady
  }

  private async createOrgIfMissing(): Promise<void> {
    const existing = await this.request('GET', `/orgs/${this.org}`)
    if (existing.ok) return
    if (existing.status !== 404) throw await hostError('Forgejo', `get org ${this.org}`, existing)
    const created = await this.request('POST', '/orgs', {
      username: this.org,
      visibility: 'private',
    })
    // 422: created concurrently; confirm it exists now.
    if (created.ok) return
    if (created.status === 422 && (await this.request('GET', `/orgs/${this.org}`)).ok) return
    throw await hostError('Forgejo', `create org ${this.org}`, created)
  }

  private repoPath(name: string): string {
    return `/repos/${this.org}/${name}`
  }

  /** Forgejo accepts an access token as the basic-auth password, whatever the username. */
  private cloneUrl(name: string): string {
    const url = new URL(`${this.baseUrl}/${this.org}/${name}.git`)
    url.username = 'hearth'
    url.password = this.token
    return url.href
  }

  private request(method: string, path: string, body?: unknown): Promise<Response> {
    return hostFetch('Forgejo', `${this.baseUrl}/api/v1${path}`, {
      method,
      headers: {
        Authorization: `token ${this.token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }
}
