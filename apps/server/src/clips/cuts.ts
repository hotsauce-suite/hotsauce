import type { TranscriptSegment } from './store.js'

/** A part of the original video left out of the edited one, in ms from its start. */
export interface Cut {
  startMs: number
  endMs: number
}

/** Enough for any real edit; a list longer than this is a client bug. */
export const MAX_CUTS = 50
/** An edit keeps at least this much video. */
export const MIN_KEPT_MS = 1000
/** Slivers shorter than this (a stray click on the timeline) are dropped. */
const MIN_CUT_MS = 100

/**
 * `cuts` made safe against a video `durationMs` long: whole milliseconds, inside the video,
 * sorted, overlapping or touching ones merged, slivers dropped. Leaves `[]` for "no edit".
 */
export function normalizeCuts(cuts: readonly Cut[], durationMs: number): Cut[] {
  const clamped = cuts
    .map((c) => ({
      startMs: Math.max(0, Math.min(durationMs, Math.round(Math.min(c.startMs, c.endMs)))),
      endMs: Math.max(0, Math.min(durationMs, Math.round(Math.max(c.startMs, c.endMs)))),
    }))
    .filter((c) => Number.isFinite(c.startMs) && Number.isFinite(c.endMs))
    .sort((a, b) => a.startMs - b.startMs)
  const merged: Cut[] = []
  for (const cut of clamped) {
    const last = merged[merged.length - 1]
    if (last && cut.startMs <= last.endMs) last.endMs = Math.max(last.endMs, cut.endMs)
    else merged.push({ ...cut })
  }
  // A cut ending within a sliver of the end (or starting near 0) reaches it: no 50 ms tail left.
  for (const cut of merged) {
    if (cut.startMs < MIN_CUT_MS) cut.startMs = 0
    if (durationMs - cut.endMs < MIN_CUT_MS) cut.endMs = durationMs
  }
  return merged.filter((c) => c.endMs - c.startMs >= MIN_CUT_MS)
}

/** The parts of a `durationMs` video that `cuts` (normalized) keep, in order. */
export function keptRanges(cuts: readonly Cut[], durationMs: number): Cut[] {
  const kept: Cut[] = []
  let at = 0
  for (const cut of cuts) {
    if (cut.startMs > at) kept.push({ startMs: at, endMs: cut.startMs })
    at = Math.max(at, cut.endMs)
  }
  if (at < durationMs) kept.push({ startMs: at, endMs: durationMs })
  return kept
}

export function keptMs(cuts: readonly Cut[], durationMs: number): number {
  return keptRanges(cuts, durationMs).reduce((sum, r) => sum + r.endMs - r.startMs, 0)
}

/** A time in the original video → the same moment in the edited one (a cut moment → its end). */
export function editedTime(ms: number, cuts: readonly Cut[]): number {
  let removed = 0
  for (const cut of cuts) {
    if (ms >= cut.endMs) removed += cut.endMs - cut.startMs
    else if (ms > cut.startMs) return cut.startMs - removed
    else break
  }
  return ms - removed
}

function inCut(ms: number, cuts: readonly Cut[]): boolean {
  return cuts.some((c) => ms >= c.startMs && ms < c.endMs)
}

/**
 * The transcript of the edited video: lines said mostly inside a cut are gone, the rest move
 * earlier by what was cut before them. Times stay in seconds.
 */
export function cutTranscript(
  segments: readonly TranscriptSegment[],
  cuts: readonly Cut[],
): TranscriptSegment[] {
  if (cuts.length === 0) return [...segments]
  const out: TranscriptSegment[] = []
  for (const seg of segments) {
    const startMs = seg.start * 1000
    const endMs = seg.end * 1000
    if (inCut((startMs + endMs) / 2, cuts)) continue
    const start = editedTime(startMs, cuts) / 1000
    const end = editedTime(endMs, cuts) / 1000
    if (end - start < 0.2 && endMs - startMs >= 0.2) continue
    out.push({ ...seg, start: round3(start), end: round3(Math.max(start, end)) })
  }
  return out
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}
