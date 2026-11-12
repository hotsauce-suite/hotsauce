import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DeepgramRetranscriber, retranscribeUrl, segmentsFromUtterances } from './retranscriber.js'

describe('retranscribeUrl', () => {
  it('asks for nova-3 utterances with each keyterm, diarized only when asked', () => {
    const url = new URL(
      retranscribeUrl('https://dg.test/v1/listen', {
        model: 'nova-3',
        vocabulary: ['Priya Shah', 'AcmeBioLab'],
        diarize: true,
      }),
    )
    expect(url.searchParams.get('model')).toBe('nova-3')
    expect(url.searchParams.get('utterances')).toBe('true')
    expect(url.searchParams.get('diarize')).toBe('true')
    expect(url.searchParams.getAll('keyterm')).toEqual(['Priya Shah', 'AcmeBioLab'])
    const plain = retranscribeUrl('https://dg.test/v1/listen', {
      model: 'nova-3',
      vocabulary: [],
      diarize: false,
    })
    expect(new URL(plain).searchParams.has('diarize')).toBe(false)
  })
})

describe('segmentsFromUtterances', () => {
  const body = {
    results: {
      utterances: [
        { transcript: ' Hello there. ', start: 1.25, end: 2.5, speaker: 1 },
        { transcript: '', start: 3, end: 3.1, speaker: 0 },
        { transcript: 'Hi.', start: 4, end: 4.5, speaker: 0 },
      ],
    },
  }

  it('labels diarized utterances like the live call side, skipping empty ones', () => {
    expect(segmentsFromUtterances(body, 'them', true)).toEqual([
      {
        track: 'them',
        speaker: 'Speaker 2',
        at: 1250,
        durationMs: 1250,
        text: 'Hello there.',
        final: true,
      },
      { track: 'them', speaker: 'Speaker 1', at: 4000, durationMs: 500, text: 'Hi.', final: true },
    ])
  })

  it('uses the track speaker when not diarized, and refuses an odd answer', () => {
    expect(segmentsFromUtterances(body, 'me', false).map((s) => s.speaker)).toEqual(['Me', 'Me'])
    expect(segmentsFromUtterances({ results: {} }, 'me', false)).toEqual([])
    expect(() => segmentsFromUtterances({ nope: 1 }, 'me', false)).toThrow(/answered oddly/)
  })
})

describe('DeepgramRetranscriber', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hearth-retranscribe-'))
    await writeFile(join(dir, 'them.pcm'), new Uint8Array(3200).fill(7))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('streams the track as WAV with the key, and maps the answer', async () => {
    const sent: Array<{
      url: string
      auth: string | null
      type: string | null
      bytes: Uint8Array
    }> = []
    const fetchStub = (async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers)
      const bytes = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer())
      sent.push({
        url,
        auth: headers.get('authorization'),
        type: headers.get('content-type'),
        bytes,
      })
      return Response.json({
        results: { utterances: [{ transcript: 'Hi.', start: 0, end: 1, speaker: 0 }] },
      })
    }) as unknown as typeof fetch
    const dg = new DeepgramRetranscriber({
      apiKey: 'k',
      url: 'https://dg.test/v1/listen',
      fetch: fetchStub,
    })
    const segments = await dg.transcribe({
      track: 'them',
      file: join(dir, 'them.pcm'),
      bytes: 3200,
      vocabulary: ['Priya'],
    })
    expect(segments.map((s) => [s.speaker, s.text])).toEqual([['Speaker 1', 'Hi.']])
    const req = sent[0]
    if (!req) throw new Error('no request')
    expect(req.auth).toBe('Token k')
    expect(req.type).toBe('audio/wav')
    expect(new URL(req.url).searchParams.get('diarize')).toBe('true')
    expect(req.bytes.length).toBe(44 + 3200)
    expect(new TextDecoder().decode(req.bytes.slice(0, 4))).toBe('RIFF')
  })

  it('does not diarize the mic, and turns a refusal into asr_error without the body', async () => {
    let url = ''
    const logs: string[] = []
    const refuse = (async (u: string) => {
      url = u
      return new Response('{"err_msg":"bad audio"}', { status: 400 })
    }) as unknown as typeof fetch
    const dg = new DeepgramRetranscriber({
      apiKey: 'k',
      url: 'https://dg.test/v1/listen',
      fetch: refuse,
      log: (m) => logs.push(m),
    })
    await expect(
      dg.transcribe({ track: 'me', file: join(dir, 'them.pcm'), bytes: 3200, vocabulary: [] }),
    ).rejects.toMatchObject({ code: 'asr_error' })
    expect(new URL(url).searchParams.has('diarize')).toBe(false)
    expect(logs[0]).toMatch(/^deepgram retranscribe 400/)
  })

  it('sends a sized upload real fetch can stream, and keeps a garbled answer out of the logs', async () => {
    const seen: Array<{ length: string | undefined; chunked: boolean; bytes: number }> = []
    const server = createServer((req, res) => {
      let bytes = 0
      req.on('data', (c: Buffer) => {
        bytes += c.length
      })
      req.on('end', () => {
        seen.push({
          length: req.headers['content-length'],
          chunked: req.headers['transfer-encoding'] === 'chunked',
          bytes,
        })
        res.setHeader('content-type', 'application/json')
        res.end(seen.length === 1 ? '{"results":{"utterances":[]}}' : '{"results": secret words')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/listen`
    const logs: string[] = []
    const dg = new DeepgramRetranscriber({ apiKey: 'k', url, log: (m) => logs.push(m) })
    const input = {
      track: 'them' as const,
      file: join(dir, 'them.pcm'),
      bytes: 3200,
      vocabulary: [],
    }
    try {
      expect(await dg.transcribe(input)).toEqual([])
      expect(seen[0]).toEqual({ length: '3244', chunked: false, bytes: 3244 })
      await expect(dg.transcribe(input)).rejects.toMatchObject({ code: 'asr_error' })
      expect(logs.join('\n')).not.toContain('secret')
    } finally {
      await new Promise((r) => server.close(r))
    }
  })
})
