import { describe, expect, it } from 'vitest'
import { FakeTranscriber } from './fake.js'
import type { Track, TranscriberSession, TranscriptSegment } from './types.js'

const FRAME = new Uint8Array(3_200) // 100 ms of 16 kHz PCM16

async function run(
  transcriber: FakeTranscriber,
  frames: Array<[Track, number]>,
): Promise<{ session: TranscriberSession; segments: TranscriptSegment[] }> {
  const session = await transcriber.start({ sessionId: 's1' })
  const segments: TranscriptSegment[] = []
  session.on('segment', (seg) => segments.push(seg))
  for (const [track, count] of frames) {
    for (let i = 0; i < count; i++) session.sendAudio(track, FRAME)
  }
  return { session, segments }
}

describe('FakeTranscriber', () => {
  it('emits one final segment per second of audio on each track', async () => {
    const { segments } = await run(new FakeTranscriber(), [
      ['me', 30],
      ['them', 20],
    ])
    expect(segments).toEqual([
      { track: 'me', speaker: 'Me', at: 0, durationMs: 1000, text: 'me segment 1', final: true },
      { track: 'me', speaker: 'Me', at: 1000, durationMs: 1000, text: 'me segment 2', final: true },
      { track: 'me', speaker: 'Me', at: 2000, durationMs: 1000, text: 'me segment 3', final: true },
      {
        track: 'them',
        speaker: 'Them',
        at: 0,
        durationMs: 1000,
        text: 'them segment 1',
        final: true,
      },
      {
        track: 'them',
        speaker: 'Them',
        at: 1000,
        durationMs: 1000,
        text: 'them segment 2',
        final: true,
      },
    ])
  })

  it('flushes the remainder on finish, then emits nothing more', async () => {
    const { session, segments } = await run(new FakeTranscriber(), [['them', 25]])
    await session.finish()
    expect(segments.map((s) => [s.text, s.at, s.durationMs])).toEqual([
      ['them segment 1', 0, 1000],
      ['them segment 2', 1000, 1000],
      ['them segment 3', 2000, 500],
    ])
    session.sendAudio('them', new Uint8Array(64_000))
    await session.finish()
    expect(segments).toHaveLength(3)
  })

  it('sends a partial when a segment is half heard, before its final', async () => {
    const { segments } = await run(new FakeTranscriber({ partials: true }), [['me', 15]])
    expect(segments.map((s) => [s.text, s.final])).toEqual([
      ['me segment 1', false],
      ['me segment 1', true],
      ['me segment 2', false],
    ])
  })

  it('is deterministic for any framing of the same audio', async () => {
    const small = await run(new FakeTranscriber({ bytesPerSegment: 6_400 }), [['me', 7]])
    const session = await new FakeTranscriber({ bytesPerSegment: 6_400 }).start({ sessionId: 's' })
    const big: TranscriptSegment[] = []
    session.on('segment', (seg) => big.push(seg))
    session.sendAudio('me', new Uint8Array(7 * 3_200))
    expect(big).toEqual(small.segments)
  })

  it('stops calling a listener once it unsubscribes, and records started sessions', async () => {
    const transcriber = new FakeTranscriber()
    const session = await transcriber.start({ sessionId: 'abc' })
    const segments: TranscriptSegment[] = []
    const off = session.on('segment', (seg) => segments.push(seg))
    session.sendAudio('me', new Uint8Array(32_000))
    off()
    session.sendAudio('me', new Uint8Array(32_000))
    expect(segments).toHaveLength(1)
    expect(transcriber.started).toEqual(['abc'])
  })
})
