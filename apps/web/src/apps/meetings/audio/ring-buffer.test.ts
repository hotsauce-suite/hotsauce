import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { AudioRing, RING_BYTES_PER_TRACK } from './ring-buffer'

// The ring builds its key ranges from the page's IDBKeyRange.
globalThis.IDBKeyRange = IDBKeyRange

const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill)

/** The stored bytes in [from, to) as one array. */
async function readAll(ring: AudioRing, track: 'me' | 'them', from: number, to?: number) {
  const chunks = await ring.read('s1', track, from, to)
  return chunks.flatMap((c) => [...c.bytes])
}

describe('AudioRing', () => {
  let ring: AudioRing

  beforeEach(() => {
    ring = new AudioRing({ factory: new IDBFactory(), maxBytesPerTrack: 10 })
  })

  it('stores chunks per track and replays from any byte offset', async () => {
    await ring.append('s1', 'me', 0, bytes(4, 1))
    await ring.append('s1', 'me', 4, bytes(4, 2))
    await ring.append('s1', 'them', 0, bytes(3, 9))

    expect(await readAll(ring, 'me', 0)).toEqual([1, 1, 1, 1, 2, 2, 2, 2])
    // From the middle of the first chunk: its tail, then the next chunk whole.
    expect(await readAll(ring, 'me', 2)).toEqual([1, 1, 2, 2, 2, 2])
    const chunks = await ring.read('s1', 'me', 2)
    expect(chunks.map((c) => c.offset)).toEqual([2, 4])
    expect(await readAll(ring, 'me', 3, 6)).toEqual([1, 2, 2])
    expect(await readAll(ring, 'me', 8)).toEqual([])
    expect(await readAll(ring, 'them', 0)).toEqual([9, 9, 9])
  })

  it('reports where each track ends, also for a fresh ring over the same database', async () => {
    const factory = new IDBFactory()
    const first = new AudioRing({ factory })
    expect(await first.end('s1', 'me')).toBe(0)
    await first.append('s1', 'me', 0, bytes(3200, 1))
    await first.append('s1', 'me', 3200, bytes(3200, 2))
    // After a reload the page builds a new ring; the audio is still there.
    const reloaded = new AudioRing({ factory })
    expect(await reloaded.end('s1', 'me')).toBe(6400)
    expect(await reloaded.end('s1', 'them')).toBe(0)
  })

  it('drops chunks wholly older than the window and keeps the rest', async () => {
    for (let i = 0; i < 6; i++) await ring.append('s1', 'me', i * 4, bytes(4, i))
    // 24 bytes written, window 10: chunks ending at or before 14 are gone; [12, 16) straddles.
    const chunks = await ring.read('s1', 'me', 0)
    expect(chunks.map((c) => c.offset)).toEqual([12, 16, 20])
    expect(await readAll(ring, 'me', 0)).toEqual([3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5])
  })

  it('keeps five minutes of 16 kHz PCM16 per track by default', () => {
    expect(RING_BYTES_PER_TRACK).toBe(5 * 60 * 16_000 * 2)
  })

  it('clears one session without touching another', async () => {
    await ring.append('s1', 'me', 0, bytes(2, 1))
    await ring.append('s1', 'them', 0, bytes(2, 1))
    await ring.append('s2', 'me', 0, bytes(2, 7))
    await ring.clear('s1')
    expect(await ring.end('s1', 'me')).toBe(0)
    expect(await ring.end('s1', 'them')).toBe(0)
    expect(await ring.read('s2', 'me', 0)).toHaveLength(1)
  })

  it('keeps nothing, and never throws, without IndexedDB', async () => {
    const none = new AudioRing({ factory: null })
    await none.append('s1', 'me', 0, bytes(4, 1))
    expect(await none.read('s1', 'me', 0)).toEqual([])
    expect(await none.end('s1', 'me')).toBe(0)
    await expect(none.clear('s1')).resolves.toBeUndefined()
  })
})
