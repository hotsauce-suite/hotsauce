import { describe, expect, it } from 'vitest'
import { HearthError } from '../errors.js'
import {
  DeepgramClipTranscriber,
  deepgramClipUrl,
  FakeClipTranscriber,
  mapDeepgramClip,
} from './transcriber.js'

describe('deepgramClipUrl', () => {
  it('asks for nova-3 with paragraphs, utterances and each keyterm', () => {
    const url = new URL(deepgramClipUrl('https://api.deepgram.com/v1/listen', ['Acme', 'Hearth']))
    expect(url.searchParams.get('model')).toBe('nova-3')
    expect(url.searchParams.get('smart_format')).toBe('true')
    expect(url.searchParams.get('punctuate')).toBe('true')
    expect(url.searchParams.get('paragraphs')).toBe('true')
    expect(url.searchParams.get('utterances')).toBe('true')
    expect(url.searchParams.getAll('keyterm')).toEqual(['Acme', 'Hearth'])
  })
})

describe('mapDeepgramClip', () => {
  const body = (alt: object, utterances?: object[]) => ({
    metadata: { duration: 12.5 },
    results: { channels: [{ alternatives: [alt] }], ...(utterances ? { utterances } : {}) },
  })

  it('makes one line per sentence, in paragraph order', () => {
    const segments = mapDeepgramClip(
      body({
        transcript: 'Hi there. This is the bug. It happens on save.',
        paragraphs: {
          paragraphs: [
            { sentences: [{ text: 'Hi there.', start: 0.08, end: 0.9 }] },
            {
              sentences: [
                { text: 'This is the bug.', start: 1.5, end: 2.666 },
                { text: ' It happens on save. ', start: 3, end: 4.2 },
              ],
            },
          ],
        },
      }),
    )
    expect(segments).toEqual([
      { start: 0.08, end: 0.9, text: 'Hi there.' },
      { start: 1.5, end: 2.67, text: 'This is the bug.' },
      { start: 3, end: 4.2, text: 'It happens on save.' },
    ])
  })

  it('falls back to utterances, then to the whole transcript, then to nothing', () => {
    expect(
      mapDeepgramClip(body({ transcript: 'a b' }, [{ transcript: 'a b', start: 1, end: 2 }])),
    ).toEqual([{ start: 1, end: 2, text: 'a b' }])
    expect(mapDeepgramClip(body({ transcript: ' only text ' }))).toEqual([
      { start: 0, end: 0, text: 'only text' },
    ])
    expect(mapDeepgramClip(body({ transcript: '' }))).toEqual([])
  })

  it('is an asr_error for a body that isn’t a Deepgram response', () => {
    expect(() => mapDeepgramClip({ nope: true })).toThrow(HearthError)
  })
})

describe('DeepgramClipTranscriber', () => {
  it('posts the audio with its type and the key, and maps the answer', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init })
      return Response.json({
        results: { channels: [{ alternatives: [{ transcript: 'Hello.' }] }] },
      })
    }) as unknown as typeof globalThis.fetch
    const t = new DeepgramClipTranscriber({ apiKey: 'k', url: 'http://dg.test/v1/listen', fetch })
    const out = await t.transcribe(new Uint8Array([1, 2]), {
      mimeType: 'audio/flac',
      keyterms: ['Acme'],
      durationMs: 1000,
    })
    expect(out).toEqual([{ start: 0, end: 0, text: 'Hello.' }])
    expect(seen[0]?.url).toContain('keyterm=Acme')
    const headers = seen[0]?.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Token k')
    expect(headers['Content-Type']).toBe('audio/flac')
  })

  it('turns a refusal or a network failure into asr_error without the body in the message', async () => {
    const logs: string[] = []
    const refuse = (async () =>
      new Response('{"err_msg":"bad audio"}', { status: 400 })) as unknown as typeof fetch
    const t = new DeepgramClipTranscriber({ apiKey: 'k', fetch: refuse, log: (m) => logs.push(m) })
    const opts = { mimeType: 'audio/flac', keyterms: [], durationMs: 1 }
    await expect(t.transcribe(new Uint8Array([1]), opts)).rejects.toMatchObject({
      code: 'asr_error',
      message: 'The transcription service refused this audio',
    })
    expect(logs[0]).toContain('400')
    const down = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const t2 = new DeepgramClipTranscriber({ apiKey: 'k', fetch: down, log: () => {} })
    await expect(t2.transcribe(new Uint8Array([1]), opts)).rejects.toMatchObject({
      code: 'asr_error',
    })
  })
})

describe('FakeClipTranscriber', () => {
  it('says "clip segment n" every two seconds of the clip', async () => {
    const fake = new FakeClipTranscriber()
    const out = await fake.transcribe(new Uint8Array(), {
      mimeType: 'audio/flac',
      keyterms: [],
      durationMs: 5100,
    })
    expect(out).toEqual([
      { start: 0, end: 2, text: 'clip segment 1' },
      { start: 2, end: 4, text: 'clip segment 2' },
      { start: 4, end: 5.1, text: 'clip segment 3' },
    ])
  })
})
