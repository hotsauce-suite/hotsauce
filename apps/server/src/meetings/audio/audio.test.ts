import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { R2AudioStore } from './r2.js'
import { wavHeader } from './wav.js'

describe('wavHeader', () => {
  it('describes 16 kHz mono PCM16 of the given length', () => {
    const h = wavHeader(32_000)
    expect(h.length).toBe(44)
    expect(h.toString('ascii', 0, 4)).toBe('RIFF')
    expect(h.readUInt32LE(4)).toBe(36 + 32_000)
    expect(h.toString('ascii', 8, 16)).toBe('WAVEfmt ')
    expect(h.readUInt16LE(22)).toBe(1)
    expect(h.readUInt32LE(24)).toBe(16_000)
    expect(h.readUInt32LE(28)).toBe(32_000)
    expect(h.readUInt32LE(40)).toBe(32_000)
  })
})

describe('R2AudioStore', () => {
  function storeWith(respond: (req: Request) => Response) {
    const seen: { req: Request; body: Uint8Array | null }[] = []
    const store = new R2AudioStore({
      accountId: 'acct',
      accessKeyId: 'AKID',
      secretAccessKey: 'secret',
      bucket: 'hearth-audio',
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init)
        const body = req.body ? new Uint8Array(await req.arrayBuffer()) : null
        seen.push({ req, body })
        return respond(req)
      }) as typeof fetch,
    })
    return { store, seen }
  }

  it('PUTs a signed, streamed object at the bucket path', async () => {
    const { store, seen } = storeWith(() => new Response(null, { status: 200 }))
    await store.put('meetings/01ABC/me.wav', Readable.from([Buffer.from('hello')]), 5, 'audio/wav')

    const { req, body } = seen[0] ?? { req: new Request('about:blank'), body: null }
    expect(req.method).toBe('PUT')
    expect(req.url).toBe('https://acct.r2.cloudflarestorage.com/hearth-audio/meetings/01ABC/me.wav')
    expect(req.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\//)
    expect(req.headers.get('x-amz-content-sha256')).toBe('UNSIGNED-PAYLOAD')
    expect(req.headers.get('content-type')).toBe('audio/wav')
    expect(new TextDecoder().decode(body ?? new Uint8Array())).toBe('hello')
  })

  it('reports a refused upload, and a missing object as null', async () => {
    const refused = storeWith(() => new Response('denied', { status: 403 }))
    await expect(
      refused.store.put('k.wav', Readable.from([Buffer.from('x')]), 1, 'audio/wav'),
    ).rejects.toThrow(/403 denied/)

    const missing = storeWith(() => new Response(null, { status: 404 }))
    expect(await missing.store.get('k.wav')).toBeNull()
  })
})

describe('R2AudioStore.presignGet', () => {
  const store = new R2AudioStore({
    accountId: 'acct',
    accessKeyId: 'AKID',
    secretAccessKey: 'secret',
    bucket: 'hearth',
  })

  it('signs a GET for a window, so the URL is stable within it and valid for two', async () => {
    const at = (iso: string) =>
      store.presignGet('clips/01ABC/video.mp4', { windowSeconds: 3600, now: new Date(iso) })
    const a = new URL(await at('2026-11-10T10:05:00Z'))
    const b = new URL(await at('2026-11-10T10:55:00Z'))
    const c = new URL(await at('2026-11-10T11:01:00Z'))
    expect(a.href).toBe(b.href)
    expect(c.href).not.toBe(a.href)
    expect(a.host).toBe('acct.r2.cloudflarestorage.com')
    expect(a.pathname).toBe('/hearth/clips/01ABC/video.mp4')
    expect(a.searchParams.get('X-Amz-Date')).toBe('20261110T100000Z')
    expect(a.searchParams.get('X-Amz-Expires')).toBe('7200')
    expect(a.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('asks R2 to send a download as an attachment with its name', async () => {
    const url = new URL(
      await store.presignGet('clips/01ABC/video.mp4', {
        windowSeconds: 3600,
        download: 'Démo "v2".mp4',
      }),
    )
    expect(url.searchParams.get('response-content-disposition')).toBe(
      `attachment; filename="D_mo _v2_.mp4"; filename*=UTF-8''D%C3%A9mo%20%22v2%22.mp4`,
    )
  })
})
