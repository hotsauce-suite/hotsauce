import { describe, expect, it } from 'vitest'
import { cutTranscript, editedTime, keptMs, keptRanges, normalizeCuts } from './cuts.js'

describe('normalizeCuts', () => {
  it('sorts, clamps to the video, merges overlaps and drops slivers', () => {
    expect(
      normalizeCuts(
        [
          { startMs: 8000, endMs: 9000 },
          { startMs: 1000, endMs: 2000 },
          { startMs: 1500, endMs: 3000 },
          { startMs: 5000, endMs: 5050 },
          { startMs: 9500, endMs: 20_000 },
        ],
        10_000,
      ),
    ).toEqual([
      { startMs: 1000, endMs: 3000 },
      { startMs: 8000, endMs: 9000 },
      { startMs: 9500, endMs: 10_000 },
    ])
  })

  it('reads a backwards range the right way round and stretches near-edge cuts to the edge', () => {
    expect(normalizeCuts([{ startMs: 3000, endMs: 50 }], 10_000)).toEqual([
      { startMs: 0, endMs: 3000 },
    ])
    expect(normalizeCuts([{ startMs: 7000, endMs: 9960 }], 10_000)).toEqual([
      { startMs: 7000, endMs: 10_000 },
    ])
  })

  it('leaves nothing for no cuts', () => {
    expect(normalizeCuts([], 10_000)).toEqual([])
  })
})

describe('kept ranges and times', () => {
  const cuts = [
    { startMs: 0, endMs: 1000 },
    { startMs: 4000, endMs: 6000 },
  ]

  it('keeps what lies between the cuts', () => {
    expect(keptRanges(cuts, 10_000)).toEqual([
      { startMs: 1000, endMs: 4000 },
      { startMs: 6000, endMs: 10_000 },
    ])
    expect(keptMs(cuts, 10_000)).toBe(7000)
    expect(keptRanges([], 5000)).toEqual([{ startMs: 0, endMs: 5000 }])
  })

  it('maps original times to edited ones; a cut moment goes to where the cut was', () => {
    expect(editedTime(500, cuts)).toBe(0)
    expect(editedTime(1000, cuts)).toBe(0)
    expect(editedTime(3000, cuts)).toBe(2000)
    expect(editedTime(5000, cuts)).toBe(3000)
    expect(editedTime(7000, cuts)).toBe(4000)
  })
})

describe('cutTranscript', () => {
  it('drops lines said in a cut and moves the rest earlier', () => {
    const segments = [
      { start: 0.2, end: 0.8, text: 'um', speaker: 0 },
      { start: 1.5, end: 3, text: 'kept one', speaker: 0 },
      { start: 4.2, end: 5.8, text: 'cut out', speaker: 1 },
      { start: 6.5, end: 8, text: 'kept two', speaker: 1 },
    ]
    expect(
      cutTranscript(segments, [
        { startMs: 0, endMs: 1000 },
        { startMs: 4000, endMs: 6000 },
      ]),
    ).toEqual([
      { start: 0.5, end: 2, text: 'kept one', speaker: 0 },
      { start: 3.5, end: 5, text: 'kept two', speaker: 1 },
    ])
  })

  it('keeps a line that only starts in a cut, from the cut on', () => {
    expect(
      cutTranscript(
        [{ start: 3.5, end: 7, text: 'mostly kept' }],
        [{ startMs: 3000, endMs: 4000 }],
      ),
    ).toEqual([{ start: 3, end: 6, text: 'mostly kept' }])
  })
})
