// The trim editor's arithmetic: the same rules as the server's (apps/server/src/clips/cuts.ts),
// so what the editor shows is what the server makes.

import type { ClipCut as Cut } from '../../api/clips'

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

/** Where the kept video starts: the end of a cut from 0, else 0. */
export function trimStart(cuts: readonly Cut[]): number {
  const first = cuts[0]
  return first && first.startMs === 0 ? first.endMs : 0
}

/** Where the kept video ends: the start of a cut to the end, else the end. */
export function trimEnd(cuts: readonly Cut[], durationMs: number): number {
  const last = cuts[cuts.length - 1]
  return last && last.endMs >= durationMs ? last.startMs : durationMs
}

/** The cuts strictly inside the video (not the start or end trim). */
export function middleCuts(cuts: readonly Cut[], durationMs: number): Cut[] {
  return cuts.filter((c) => c.startMs > 0 && c.endMs < durationMs)
}

/**
 * The cuts with the kept video starting at `startMs` and ending at `endMs`, the middle cuts kept.
 * Handles never cross: each stays at least `MIN_KEPT_MS` from the other.
 */
export function withTrim(
  cuts: readonly Cut[],
  durationMs: number,
  startMs: number,
  endMs: number,
): Cut[] {
  const start = Math.max(0, Math.min(startMs, durationMs - MIN_KEPT_MS))
  const end = Math.min(durationMs, Math.max(endMs, start + MIN_KEPT_MS))
  const next = middleCuts(cuts, durationMs)
  if (start > 0) next.push({ startMs: 0, endMs: start })
  if (end < durationMs) next.push({ startMs: end, endMs: durationMs })
  return normalizeCuts(next, durationMs)
}

/** The cut that `ms` falls in, if any. */
export function cutAt(cuts: readonly Cut[], ms: number): Cut | undefined {
  return cuts.find((c) => ms >= c.startMs && ms < c.endMs)
}
