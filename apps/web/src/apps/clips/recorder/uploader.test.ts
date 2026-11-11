import { describe, expect, it } from 'vitest'
import { HearthApiError } from '../../../api/client'
import { ChunkUploader, isRetryable } from './uploader'

const blob = (s: string) => new Blob([s])
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('ChunkUploader', () => {
  it('sends chunks in order, numbered from 0, and drains', async () => {
    const sent: Array<[number, string]> = []
    const up = new ChunkUploader(async (seq, data) => {
      sent.push([seq, await data.text()])
    })
    up.add(blob('a'))
    up.add(blob(''))
    up.add(blob('b'))
    await up.drain()
    expect(sent).toEqual([
      [0, 'a'],
      [1, 'b'],
    ])
    expect(up.state).toMatchObject({ chunks: 2, sent: 2, pendingBytes: 0, retrying: false })
  })

  it('retries a chunk through a network blip, with growing waits, then carries on', async () => {
    const waits: number[] = []
    let failures = 3
    const sent: number[] = []
    const up = new ChunkUploader(
      async (seq) => {
        if (seq === 1 && failures-- > 0) {
          throw new HearthApiError('network', 'Could not reach the Hearth server', 0)
        }
        sent.push(seq)
      },
      async (ms) => {
        waits.push(ms)
      },
    )
    const states: boolean[] = []
    up.subscribe((s) => states.push(s.retrying))
    for (const s of ['a', 'b', 'c']) up.add(blob(s))
    await up.drain()
    expect(sent).toEqual([0, 1, 2])
    expect(waits).toEqual([1000, 2000, 4000])
    expect(states).toContain(true)
    expect(up.state.retrying).toBe(false)
  })

  it('stops for good when the server refuses, and drain says why', async () => {
    const up = new ChunkUploader(async () => {
      throw new HearthApiError('conflict', 'This recording has already been finished', 409)
    })
    up.add(blob('a'))
    await expect(up.drain()).rejects.toThrow('already been finished')
    up.add(blob('b'))
    expect(up.state.chunks).toBe(1)
    expect(up.state.fatal?.message).toContain('already been finished')
  })

  it('drops what is queued when stopped', async () => {
    let release = () => {}
    const up = new ChunkUploader(() => new Promise<void>((r) => (release = r)))
    up.add(blob('a'))
    up.add(blob('b'))
    await tick()
    up.stop()
    release()
    await tick()
    expect(up.state.pendingBytes).toBe(0)
  })

  it('retries what is worth retrying', () => {
    expect(isRetryable(new TypeError('fetch failed'))).toBe(true)
    expect(isRetryable(new HearthApiError('server_error', 'x', 502))).toBe(true)
    expect(isRetryable(new HearthApiError('rate_limited', 'x', 429))).toBe(true)
    expect(isRetryable(new HearthApiError('forbidden', 'x', 403))).toBe(false)
    expect(isRetryable(new HearthApiError('too_large', 'x', 413))).toBe(false)
  })
})
