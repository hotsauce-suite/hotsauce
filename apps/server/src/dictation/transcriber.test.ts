import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { HearthError } from '../errors.js'
import {
  DeepgramDictationTranscriber,
  deepgramBatchUrl,
  FakeDictationTranscriber,
  mapDeepgramResponse,
} from './transcriber.js'

const PRERECORDED: unknown = JSON.parse(
  readFileSync(new URL('../../test/fixtures/deepgram/prerecorded.json', import.meta.url), 'utf8'),
)

describe('mapDeepgramResponse', () => {
  it('takes the first alternative’s transcript and the duration', () => {
    expect(mapDeepgramResponse(PRERECORDED)).toEqual({
      text: 'Um, so I think we should, uh, ship the Acme report on Tuesday. No wait, Wednesday.',
      durationMs: 6250,
    })
  })

  it('gives empty text for silence', () => {
    expect(
      mapDeepgramResponse({
        metadata: { duration: 1 },
        results: { channels: [{ alternatives: [] }] },
      }),
    ).toEqual({ text: '', durationMs: 1000 })
  })

  it('is asr_error for anything else', () => {
    expect(() => mapDeepgramResponse({ err_code: 'Bad Request' })).toThrow(HearthError)
  })
})

describe('deepgramBatchUrl', () => {
  it('asks for nova-3 with formatting, each keyterm repeated', () => {
    const url = new URL(
      deepgramBatchUrl('https://api.deepgram.com/v1/listen', {
        keyterms: ['Acme', 'Acme'],
        language: 'en',
      }),
    )
    expect(url.searchParams.get('model')).toBe('nova-3')
    expect(url.searchParams.get('smart_format')).toBe('true')
    expect(url.searchParams.get('punctuate')).toBe('true')
    expect(url.searchParams.get('language')).toBe('en')
    expect(url.searchParams.getAll('keyterm')).toEqual(['Acme', 'Acme'])
  })
})

describe('DeepgramDictationTranscriber', () => {
  it('posts the audio with the key and content type', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(PRERECORDED), { status: 200 }))
    const asr = new DeepgramDictationTranscriber({
      apiKey: 'dg-key',
      fetch: fetch as typeof globalThis.fetch,
    })
    const result = await asr.transcribe(new Uint8Array([1, 2, 3]), {
      mimeType: 'audio/wav',
      keyterms: ['Hearth'],
    })
    expect(result.durationMs).toBe(6250)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(new URL(url).searchParams.getAll('keyterm')).toEqual(['Hearth'])
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ Authorization: 'Token dg-key', 'Content-Type': 'audio/wav' })
  })

  it('maps a refusal and a network failure to asr_error without the audio', async () => {
    const log = vi.fn()
    const refused = new DeepgramDictationTranscriber({
      apiKey: 'k',
      log,
      fetch: (async () => new Response('{"err_msg":"bad audio"}', { status: 400 })) as typeof fetch,
    })
    await expect(
      refused.transcribe(new Uint8Array(1), { mimeType: 'audio/wav', keyterms: [] }),
    ).rejects.toMatchObject({
      code: 'asr_error',
      status: 502,
    })
    const down = new DeepgramDictationTranscriber({
      apiKey: 'k',
      log,
      fetch: (async () => {
        throw new TypeError('fetch failed')
      }) as typeof fetch,
    })
    await expect(
      down.transcribe(new Uint8Array(1), { mimeType: 'audio/wav', keyterms: [] }),
    ).rejects.toMatchObject({
      code: 'asr_error',
    })
  })
})

describe('FakeDictationTranscriber', () => {
  it('is deterministic and records its options', async () => {
    const fake = new FakeDictationTranscriber()
    const a = await fake.transcribe(new Uint8Array(32_000), {
      mimeType: 'audio/webm',
      keyterms: ['x'],
    })
    expect(a).toEqual({
      text: 'um so this is a fake dictation, uh, of 1.0 seconds',
      durationMs: 1000,
    })
    expect(fake.calls).toEqual([{ mimeType: 'audio/webm', keyterms: ['x'] }])
  })
})
