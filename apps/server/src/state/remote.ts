/**
 * Where the state mirror keeps durable files (docs/PLAN-cloudflare-deploy.md). A tiny HTTP object
 * store, so the same server works against R2 behind a Cloudflare Worker (the container calls
 * `http://state.hotsauce`, which the Worker answers from its R2 binding) or any small service that
 * speaks the same four routes:
 *
 *   GET    <base>/list        → 200 {"keys": ["org/settings.json", …]}
 *   GET    <base>/o/<key>     → 200 body, or 404
 *   PUT    <base>/o/<key>     → 2xx
 *   DELETE <base>/o/<key>     → 2xx (404 counts as done)
 *
 * Keys are relative POSIX paths under DATA_DIR; each segment is URL-encoded.
 */
export interface StateRemote {
  list(): Promise<string[]>
  get(key: string): Promise<Uint8Array | null>
  put(key: string, body: Uint8Array): Promise<void>
  delete(key: string): Promise<void>
}

const TIMEOUT_MS = 30_000

export class HttpStateRemote implements StateRemote {
  readonly #base: string
  readonly #headers: Record<string, string>

  constructor(baseUrl: string, token?: string) {
    this.#base = baseUrl.replace(/\/+$/, '')
    this.#headers = token ? { authorization: `Bearer ${token}` } : {}
  }

  #url(key: string): string {
    return `${this.#base}/o/${key.split('/').map(encodeURIComponent).join('/')}`
  }

  async #fetch(url: string, init: RequestInit = {}): Promise<Response> {
    return fetch(url, {
      ...init,
      headers: { ...this.#headers, ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  }

  async list(): Promise<string[]> {
    const res = await this.#fetch(`${this.#base}/list`)
    if (!res.ok) throw new Error(`state store list failed: HTTP ${res.status}`)
    const body = (await res.json()) as { keys?: unknown }
    if (!Array.isArray(body.keys)) throw new Error('state store list: no keys array')
    return body.keys.filter((k): k is string => typeof k === 'string')
  }

  async get(key: string): Promise<Uint8Array | null> {
    const res = await this.#fetch(this.#url(key))
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`state store get ${key} failed: HTTP ${res.status}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    const res = await this.#fetch(this.#url(key), {
      method: 'PUT',
      body: new Blob([new Uint8Array(body)]),
      headers: { 'content-type': 'application/octet-stream' },
    })
    if (!res.ok) throw new Error(`state store put ${key} failed: HTTP ${res.status}`)
  }

  async delete(key: string): Promise<void> {
    const res = await this.#fetch(this.#url(key), { method: 'DELETE' })
    if (!res.ok && res.status !== 404)
      throw new Error(`state store delete ${key} failed: HTTP ${res.status}`)
  }
}

/** An in-memory store, for tests and for the local stand-in server. */
export class MemoryStateRemote implements StateRemote {
  readonly files = new Map<string, Uint8Array>()
  async list(): Promise<string[]> {
    return [...this.files.keys()].sort()
  }
  async get(key: string): Promise<Uint8Array | null> {
    return this.files.get(key) ?? null
  }
  async put(key: string, body: Uint8Array): Promise<void> {
    this.files.set(key, new Uint8Array(body))
  }
  async delete(key: string): Promise<void> {
    this.files.delete(key)
  }
}
