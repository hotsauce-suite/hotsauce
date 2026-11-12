import { Readable } from 'node:stream'
import { AwsClient } from 'aws4fetch'
import { HearthError } from '../../errors.js'
import type { AudioStore } from './types.js'

export interface R2Options {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  fetch?: typeof fetch
}

/** Kept audio in a Cloudflare R2 bucket, over its S3 API. Zero egress, so playback is free. */
export class R2AudioStore implements AudioStore {
  readonly kind = 'r2'
  readonly #client: AwsClient
  readonly #fetch: typeof fetch
  readonly #base: string

  constructor(opts: R2Options) {
    this.#client = new AwsClient({
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      service: 's3',
      region: 'auto',
    })
    this.#fetch = opts.fetch ?? fetch
    this.#base = `https://${opts.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(opts.bucket)}`
  }

  async put(key: string, body: Readable, size: number, contentType: string): Promise<void> {
    // Streamed, not buffered: a three-hour track is about 350 MB. A stream can't be hashed before
    // it's sent, so the payload is unsigned, which R2 accepts over HTTPS.
    // Signed without the body (aws4fetch would buffer or consume it), then sent as a stream.
    const signed = await this.#sign(key, 'PUT', {
      'Content-Type': contentType,
      'Content-Length': String(size),
    })
    const res = await this.#fetch(signed.url, {
      method: 'PUT',
      headers: signed.headers,
      body: Readable.toWeb(body) as ReadableStream<Uint8Array>,
      duplex: 'half',
    } as RequestInit)
    if (!res.ok) {
      throw new HearthError('internal', `R2 refused ${key}: ${res.status} ${await res.text()}`)
    }
  }

  async get(key: string) {
    const signed = await this.#sign(key, 'GET', {})
    const res = await this.#fetch(signed.url, { headers: signed.headers })
    if (res.status === 404) return null
    if (!res.ok || !res.body) {
      throw new HearthError('internal', `R2 read of ${key} failed: ${res.status}`)
    }
    return { body: res.body, size: Number(res.headers.get('content-length') ?? 0) }
  }

  async delete(key: string): Promise<void> {
    const signed = await this.#sign(key, 'DELETE', {})
    const res = await this.#fetch(signed.url, { method: 'DELETE', headers: signed.headers })
    // R2 answers 204 for a key that isn't there too.
    if (!res.ok && res.status !== 404) {
      throw new HearthError('internal', `R2 delete of ${key} failed: ${res.status}`)
    }
  }

  /**
   * A GET URL for `key` that works without credentials until it expires, so a browser can stream
   * and seek a video straight from R2. Signed at the start of a fixed window and valid for two,
   * so the URL stays the same within a window and the browser's cache can reuse it.
   */
  async presignGet(
    key: string,
    opts: { windowSeconds: number; download?: string; inline?: string; now?: Date },
  ): Promise<string> {
    const nowMs = (opts.now ?? new Date()).getTime()
    const windowMs = opts.windowSeconds * 1000
    const start = new Date(Math.floor(nowMs / windowMs) * windowMs)
    const url = new URL(this.#url(key))
    url.searchParams.set('X-Amz-Expires', String(opts.windowSeconds * 2))
    if (opts.download !== undefined) {
      url.searchParams.set('response-content-disposition', contentDisposition(opts.download))
    }
    // Shown in the browser as this type (Hearth Files previews), never as a download.
    if (opts.inline !== undefined) {
      url.searchParams.set('response-content-type', opts.inline)
      url.searchParams.set('response-content-disposition', 'inline')
    }
    const signed = await this.#client.sign(url.href, {
      method: 'GET',
      aws: { signQuery: true, datetime: start.toISOString().replace(/[:-]|\.\d{3}/g, '') },
    })
    return signed.url
  }

  #sign(key: string, method: string, headers: Record<string, string>) {
    return this.#client.sign(this.#url(key), {
      method,
      headers: { ...headers, 'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD' },
    })
  }

  #url(key: string): string {
    return `${this.#base}/${key.split('/').map(encodeURIComponent).join('/')}`
  }
}

/** `attachment` with an ASCII fallback name and the real one in RFC 5987 form. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}
