import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { createAudioStore, R2AudioStore } from '../meetings/audio/index.js'
import { parseListXml, r2Endpoint, S3Client } from './s3.js'

function recorder(responses: Array<() => Response>) {
  const calls: Request[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input, init))
    const next = responses.shift()
    return next ? next() : new Response(null, { status: 200 })
  }) as typeof fetch
  return { calls, fetchImpl }
}

const opts = {
  endpoint: 'https://s3.eu-west-2.amazonaws.com',
  region: 'eu-west-2',
  bucket: 'acme-files',
  accessKeyId: 'AKIA',
  secretAccessKey: 'secret',
}

describe('S3Client (R1)', () => {
  it('uses path-style URLs on any endpoint and signs for its region', async () => {
    const { calls, fetchImpl } = recorder([])
    const s3 = new S3Client({ ...opts, fetch: fetchImpl })
    await s3.put('backups/a b.tar.gz', new Uint8Array([1, 2, 3]), 3, 'application/gzip')
    const req = calls[0] as Request
    expect(req.method).toBe('PUT')
    expect(req.url).toBe('https://s3.eu-west-2.amazonaws.com/acme-files/backups/a%20b.tar.gz')
    expect(req.headers.get('authorization')).toContain('/eu-west-2/s3/aws4_request')
    expect(req.headers.get('x-amz-content-sha256')).toBe('UNSIGNED-PAYLOAD')
  })

  it('uploads a big file in parts and completes it with their ETags', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's3-'))
    const file = join(dir, 'big.bin')
    writeFileSync(file, Buffer.alloc(25, 7))
    const bodies: string[] = []
    const { calls, fetchImpl } = recorder([
      () =>
        new Response(
          '<InitiateMultipartUploadResult><UploadId>up&amp;1</UploadId></InitiateMultipartUploadResult>',
        ),
      () => new Response(null, { headers: { etag: '"a"' } }),
      () => new Response(null, { headers: { etag: '"b"' } }),
      () => new Response(null, { headers: { etag: '"c"' } }),
      () => new Response('<CompleteMultipartUploadResult/>'),
    ])
    const s3 = new S3Client({ ...opts, fetch: fetchImpl, partBytes: 10 })
    await s3.putFile('backups/big.tar.gz', file, 25, 'application/gzip')
    for (const c of calls)
      bodies.push(c.method === 'PUT' ? String((await c.arrayBuffer()).byteLength) : await c.text())
    const urls = calls.map((c) => `${c.method} ${new URL(c.url).search}`)
    expect(urls).toEqual([
      'POST ?uploads',
      'PUT ?partNumber=1&uploadId=up%261',
      'PUT ?partNumber=2&uploadId=up%261',
      'PUT ?partNumber=3&uploadId=up%261',
      'POST ?uploadId=up%261',
    ])
    expect(bodies.slice(1, 4)).toEqual(['10', '10', '5'])
    expect(bodies[4]).toContain('<Part><PartNumber>3</PartNumber><ETag>"c"</ETag></Part>')
    rmSync(dir, { recursive: true, force: true })
  })

  it('aborts a multipart upload that fails part-way', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's3-'))
    const file = join(dir, 'big.bin')
    writeFileSync(file, Buffer.alloc(25, 7))
    const { calls, fetchImpl } = recorder([
      () =>
        new Response(
          '<InitiateMultipartUploadResult><UploadId>u</UploadId></InitiateMultipartUploadResult>',
        ),
      () => new Response('nope', { status: 500 }),
      () => new Response(null, { status: 204 }),
    ])
    const s3 = new S3Client({ ...opts, fetch: fetchImpl, partBytes: 10 })
    await expect(s3.putFile('k', file, 25, 'application/gzip')).rejects.toThrow()
    expect(calls.map((c) => c.method)).toEqual(['POST', 'PUT', 'DELETE'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('lists every page of a prefix', async () => {
    const page1 = `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t&amp;2</NextContinuationToken>
      <Contents><Key>backups/x/1.tar.gz</Key><Size>10</Size><LastModified>2026-11-01T03:00:00.000Z</LastModified></Contents>
    </ListBucketResult>`
    const page2 = `<ListBucketResult><IsTruncated>false</IsTruncated>
      <Contents><Key>backups/x/2 &amp; more.tar.gz</Key><Size>20</Size><LastModified>2026-11-02T03:00:00.000Z</LastModified></Contents>
    </ListBucketResult>`
    const { calls, fetchImpl } = recorder([() => new Response(page1), () => new Response(page2)])
    const s3 = new S3Client({ ...opts, fetch: fetchImpl })
    const got = await s3.list('backups/x/')
    expect(got.map((o) => o.key)).toEqual(['backups/x/1.tar.gz', 'backups/x/2 & more.tar.gz'])
    expect(got[1]?.size).toBe(20)
    const second = new URL((calls[1] as Request).url)
    expect(second.searchParams.get('continuation-token')).toBe('t&2')
    expect(second.searchParams.get('prefix')).toBe('backups/x/')
    expect(second.searchParams.get('list-type')).toBe('2')
  })

  it('treats a missing object as null and a missing delete as done', async () => {
    const { fetchImpl } = recorder([
      () => new Response(null, { status: 404 }),
      () => new Response(null, { status: 404 }),
    ])
    const s3 = new S3Client({ ...opts, fetch: fetchImpl })
    expect(await s3.get('nope')).toBeNull()
    await expect(s3.delete('nope')).resolves.toBeUndefined()
  })

  it('parses an empty listing', () => {
    expect(
      parseListXml('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>'),
    ).toEqual({
      objects: [],
      next: undefined,
    })
  })

  it('gives R2 its account endpoint', () => {
    expect(r2Endpoint('acct')).toBe('https://acct.r2.cloudflarestorage.com')
  })
})

describe('object store config (R2)', () => {
  const base = { NODE_ENV: 'test', AUTH_MODE: 'dev', HOST_KIND: 'local', DATA_DIR: '/tmp/x' }

  it('S3_* configure the media store on any endpoint', async () => {
    const config = loadConfig({
      ...base,
      S3_ENDPOINT: 'https://minio.acme.test',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'media',
      S3_ACCESS_KEY_ID: 'k',
      S3_SECRET_ACCESS_KEY: 's',
    })
    expect(config.AUDIO_STORE).toBe('r2')
    const store = createAudioStore(config)
    expect(store).toBeInstanceOf(R2AudioStore)
    expect((store as R2AudioStore).client.url('a/b')).toBe('https://minio.acme.test/media/a/b')
  })

  it('R2_* still work as before', () => {
    const config = loadConfig({
      ...base,
      R2_ACCOUNT_ID: 'acct',
      R2_ACCESS_KEY_ID: 'k',
      R2_SECRET_ACCESS_KEY: 's',
      R2_BUCKET: 'hearth-audio',
    })
    expect(config.OBJECT_STORE?.endpoint).toBe('https://acct.r2.cloudflarestorage.com')
    const store = createAudioStore(config) as R2AudioStore
    expect(store.client.url('k')).toBe('https://acct.r2.cloudflarestorage.com/hearth-audio/k')
  })

  it('AUDIO_STORE=s3 means the bucket store, and needs a bucket', () => {
    expect(() => loadConfig({ ...base, AUDIO_STORE: 's3' })).toThrow(/a bucket is required/)
  })

  it('without a bucket, media stays on the volume', () => {
    expect(loadConfig(base).AUDIO_STORE).toBe('local')
    expect(loadConfig(base).OBJECT_STORE).toBeNull()
  })
})
