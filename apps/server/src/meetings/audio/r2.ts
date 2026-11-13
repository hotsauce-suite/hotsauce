import type { Readable } from 'node:stream'
import { HearthError } from '../../errors.js'
import { contentDisposition, r2Endpoint, S3Client } from '../../storage/s3.js'
import type { AudioStore } from './types.js'

export { contentDisposition }

export interface R2Options {
  /** Cloudflare R2: the account id gives the endpoint. */
  accountId?: string
  /** Any S3-compatible service: its endpoint (wins over accountId) and region. */
  endpoint?: string
  region?: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  fetch?: typeof fetch | undefined
}

/**
 * Big files (kept audio, Clips video, Files) in an S3-compatible bucket: Cloudflare R2 (zero
 * egress, so playback is free) or any other S3 service. The class keeps its R2 name, and `kind`
 * stays `r2`, because pointer files written so far record `store: r2`.
 */
export class R2AudioStore implements AudioStore {
  readonly kind = 'r2'
  readonly client: S3Client

  constructor(opts: R2Options) {
    const endpoint = opts.endpoint || r2Endpoint(opts.accountId ?? '')
    this.client = new S3Client({
      endpoint,
      region: opts.region || 'auto',
      bucket: opts.bucket,
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      fetch: opts.fetch,
    })
  }

  async put(key: string, body: Readable, size: number, contentType: string): Promise<void> {
    try {
      await this.client.put(key, body, size, contentType)
    } catch (err) {
      throw new HearthError('internal', `storage refused ${key}: ${(err as Error).message}`)
    }
  }

  async get(key: string) {
    try {
      return await this.client.get(key)
    } catch (err) {
      throw new HearthError('internal', `storage read of ${key} failed: ${(err as Error).message}`)
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.delete(key)
    } catch (err) {
      throw new HearthError(
        'internal',
        `storage delete of ${key} failed: ${(err as Error).message}`,
      )
    }
  }

  presignGet(
    key: string,
    opts: { windowSeconds: number; download?: string; inline?: string; now?: Date },
  ): Promise<string> {
    return this.client.presignGet(key, opts)
  }
}
