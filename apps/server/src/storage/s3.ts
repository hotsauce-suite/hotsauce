import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { AwsClient } from 'aws4fetch'

/**
 * A minimal S3 client for any S3-compatible service: Cloudflare R2, AWS S3, Backblaze B2, Wasabi,
 * MinIO, Garage. Path-style URLs (`<endpoint>/<bucket>/<key>`), which all of them accept.
 * Requests are signed with SigV4 over `aws4fetch`; bodies are streamed with an unsigned payload,
 * which every one of these accepts over HTTPS.
 */
export interface S3Options {
  /** e.g. `https://s3.us-east-1.amazonaws.com`, `https://<account>.r2.cloudflarestorage.com`. */
  endpoint: string
  /** `auto` for R2; the bucket's region elsewhere. */
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  fetch?: typeof fetch | undefined
  /** Multipart part size; tests use a small one. */
  partBytes?: number | undefined
}

/** Files bigger than this go up in parts of this size (a part may be 5 MB to 5 GB). */
export const PART_BYTES = 256 * 1024 * 1024

/** The R2 endpoint for a Cloudflare account. */
export function r2Endpoint(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`
}

export class S3Error extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export interface S3Object {
  key: string
  size: number
  lastModified: string
}

/** What backups need from a bucket; S3Client has it, and tests use MemoryObjectStore. */
export type ObjectStore = Pick<S3Client, 'put' | 'putFile' | 'get' | 'delete' | 'list'>

/** A bucket in memory, for tests. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { body: Uint8Array; at: string }>()

  async putFile(key: string, file: string, size: number, type: string) {
    await this.put(key, createReadStream(file), size, type)
  }

  async put(key: string, body: Readable | Uint8Array, _size: number, _type: string) {
    const bytes =
      body instanceof Uint8Array ? body : new Uint8Array(Buffer.concat(await body.toArray()))
    this.objects.set(key, { body: bytes, at: new Date().toISOString() })
  }

  async get(key: string) {
    const o = this.objects.get(key)
    if (!o) return null
    return { body: new Blob([new Uint8Array(o.body)]).stream(), size: o.body.length }
  }

  async delete(key: string) {
    this.objects.delete(key)
  }

  async list(prefix: string): Promise<S3Object[]> {
    return [...this.objects]
      .filter(([k]) => k.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, o]) => ({ key, size: o.body.length, lastModified: o.at }))
  }
}

export class S3Client {
  readonly #client: AwsClient
  readonly #fetch: typeof fetch
  readonly #base: string
  readonly bucket: string
  readonly #partBytes: number

  constructor(opts: S3Options) {
    this.#client = new AwsClient({
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      service: 's3',
      region: opts.region || 'auto',
    })
    this.#fetch = opts.fetch ?? fetch
    this.bucket = opts.bucket
    this.#partBytes = opts.partBytes ?? PART_BYTES
    this.#base = `${opts.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(opts.bucket)}`
  }

  /** Stores `size` bytes from `body` at `key`, streamed (a three-hour track is ~350 MB). */
  async put(
    key: string,
    body: Readable | Uint8Array,
    size: number,
    contentType: string,
    signal?: AbortSignal,
  ) {
    await this.#putTo(this.url(key), body, size, contentType, signal)
  }

  /**
   * Stores a file from disk. Past `PART_BYTES` it goes up in parts (multipart upload), since S3,
   * R2 and B2 refuse a single PUT over 5 GB; a failed upload is aborted so its parts don't linger.
   */
  async putFile(
    key: string,
    file: string,
    size: number,
    contentType: string,
    signal?: AbortSignal,
  ) {
    if (size <= this.#partBytes) {
      await this.put(key, createReadStream(file), size, contentType, signal)
      return
    }
    const create = await this.#request(
      'POST',
      `${this.url(key)}?uploads`,
      {
        'Content-Type': contentType,
      },
      signal,
    )
    const uploadId = tag(await create.text(), 'UploadId')
    if (!uploadId) throw new S3Error(`start upload ${key}: no UploadId`, create.status)
    const upload = (n: number) =>
      `${this.url(key)}?partNumber=${n}&uploadId=${encodeURIComponent(unxml(uploadId))}`
    try {
      const etags: string[] = []
      for (let n = 1, start = 0; start < size; n++, start += this.#partBytes) {
        const end = Math.min(size, start + this.#partBytes) - 1
        const res = await this.#putTo(
          upload(n),
          createReadStream(file, { start, end }),
          end - start + 1,
          'application/octet-stream',
          signal,
        )
        etags.push(res.headers.get('etag') ?? '')
      }
      const xml = `<CompleteMultipartUpload>${etags
        .map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e}</ETag></Part>`)
        .join('')}</CompleteMultipartUpload>`
      const done = await this.#request(
        'POST',
        `${this.url(key)}?uploadId=${encodeURIComponent(unxml(uploadId))}`,
        { 'Content-Type': 'application/xml' },
        signal,
        xml,
      )
      const text = await done.text()
      // S3 can answer 200 with an error in the body.
      if (text.includes('<Error>')) throw new S3Error(`finish upload ${key}: ${text}`, 200)
    } catch (err) {
      await this.#request(
        'DELETE',
        `${this.url(key)}?uploadId=${encodeURIComponent(unxml(uploadId))}`,
        {},
      ).catch(() => undefined)
      throw err
    }
  }

  async #request(
    method: string,
    url: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
    body?: string,
  ): Promise<Response> {
    const signed = await this.#sign(url, method, headers)
    const res = await this.#fetch(signed.url, {
      method,
      headers: signed.headers,
      ...(body !== undefined ? { body } : {}),
      ...(signal ? { signal } : {}),
    })
    if (!res.ok)
      throw new S3Error(`${method} ${url}: ${res.status} ${await res.text()}`, res.status)
    return res
  }

  async #putTo(
    url: string,
    body: Readable | Uint8Array,
    size: number,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const signed = await this.#sign(url, 'PUT', {
      'Content-Type': contentType,
      'Content-Length': String(size),
    })
    const res = await this.#fetch(signed.url, {
      method: 'PUT',
      headers: signed.headers,
      ...(signal ? { signal } : {}),
      body:
        body instanceof Uint8Array
          ? new Blob([new Uint8Array(body)])
          : (Readable.toWeb(body) as ReadableStream<Uint8Array>),
      duplex: 'half',
    } as RequestInit)
    if (!res.ok) {
      throw new S3Error(
        `put ${new URL(url).pathname}: ${res.status} ${await res.text()}`,
        res.status,
      )
    }
    return res
  }

  /** The object's bytes, or null when there's nothing at `key`. */
  async get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null> {
    const signed = await this.#sign(this.url(key), 'GET', {})
    const res = await this.#fetch(signed.url, { headers: signed.headers })
    if (res.status === 404) return null
    if (!res.ok || !res.body) throw new S3Error(`get ${key}: ${res.status}`, res.status)
    return { body: res.body, size: Number(res.headers.get('content-length') ?? 0) }
  }

  /** Removes the object at `key`; nothing there is not an error. */
  async delete(key: string): Promise<void> {
    const signed = await this.#sign(this.url(key), 'DELETE', {})
    const res = await this.#fetch(signed.url, { method: 'DELETE', headers: signed.headers })
    if (!res.ok && res.status !== 404) throw new S3Error(`delete ${key}: ${res.status}`, res.status)
  }

  /** Every object whose key starts with `prefix` (ListObjectsV2, all pages). */
  async list(prefix: string): Promise<S3Object[]> {
    const out: S3Object[] = []
    let token: string | undefined
    do {
      const url = new URL(this.#base)
      url.searchParams.set('list-type', '2')
      url.searchParams.set('prefix', prefix)
      if (token) url.searchParams.set('continuation-token', token)
      const signed = await this.#sign(url.href, 'GET', {})
      const res = await this.#fetch(signed.url, { headers: signed.headers })
      if (!res.ok)
        throw new S3Error(`list ${prefix}: ${res.status} ${await res.text()}`, res.status)
      const page = parseListXml(await res.text())
      out.push(...page.objects)
      token = page.next
    } while (token)
    return out
  }

  /**
   * A GET URL for `key` that works without credentials until it expires. Signed at the start of a
   * fixed window and valid for two, so the URL stays the same within a window (cacheable).
   */
  async presignGet(
    key: string,
    opts: { windowSeconds: number; download?: string; inline?: string; now?: Date },
  ): Promise<string> {
    const nowMs = (opts.now ?? new Date()).getTime()
    const windowMs = opts.windowSeconds * 1000
    const start = new Date(Math.floor(nowMs / windowMs) * windowMs)
    const url = new URL(this.url(key))
    url.searchParams.set('X-Amz-Expires', String(opts.windowSeconds * 2))
    if (opts.download !== undefined) {
      url.searchParams.set('response-content-disposition', contentDisposition(opts.download))
    }
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

  url(key: string): string {
    return `${this.#base}/${key.split('/').map(encodeURIComponent).join('/')}`
  }

  #sign(url: string, method: string, headers: Record<string, string>) {
    return this.#client.sign(url, {
      method,
      headers: { ...headers, 'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD' },
    })
  }
}

/** `attachment` with an ASCII fallback name and the real one in RFC 5987 form. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}
const unxml = (s: string) =>
  s.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1))
      return String.fromCodePoint(n)
    }
    return XML_ENTITIES[e] ?? m
  })
const tag = (xml: string, name: string) =>
  xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]

/** The objects and next continuation token in a ListObjectsV2 response. */
export function parseListXml(xml: string): { objects: S3Object[]; next?: string | undefined } {
  const objects: S3Object[] = []
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const body = m[1] as string
    const key = tag(body, 'Key')
    if (key === undefined) continue
    objects.push({
      key: unxml(key),
      size: Number(tag(body, 'Size') ?? 0),
      lastModified: tag(body, 'LastModified') ?? '',
    })
  }
  const truncated = tag(xml, 'IsTruncated') === 'true'
  const next = tag(xml, 'NextContinuationToken')
  return { objects, next: truncated && next ? unxml(next) : undefined }
}
