// A deliberately simple line-based three-way merge: each side's edits collapse into one
// changed region (common prefix/suffix against the base). Two regions merge cleanly only when
// at least one untouched line separates them; anything closer is a conflict. That is more
// conservative than `git merge-file`, never less, which is the right side to err on.

export type Merge3Result = { clean: true; text: string } | { clean: false; withMarkers: string }

interface Region {
  start: number
  end: number
  lines: string[]
}

function changedRegion(base: string[], other: string[]): Region {
  const max = Math.min(base.length, other.length)
  let prefix = 0
  while (prefix < max && base[prefix] === other[prefix]) prefix++
  let suffix = 0
  while (
    suffix < base.length - prefix &&
    suffix < other.length - prefix &&
    base[base.length - 1 - suffix] === other[other.length - 1 - suffix]
  ) {
    suffix++
  }
  return {
    start: prefix,
    end: base.length - suffix,
    lines: other.slice(prefix, other.length - suffix),
  }
}

/** The lines a side has in place of base[start, end), where its region lies inside that span. */
function sideSpan(base: string[], region: Region, start: number, end: number): string[] {
  return [...base.slice(start, region.start), ...region.lines, ...base.slice(region.end, end)]
}

export function merge3(base: string, ours: string, theirs: string): Merge3Result {
  if (ours === theirs || theirs === base) return { clean: true, text: ours }
  if (ours === base) return { clean: true, text: theirs }

  const b = base.split('\n')
  const o = changedRegion(b, ours.split('\n'))
  const t = changedRegion(b, theirs.split('\n'))

  if (o.end < t.start || t.end < o.start) {
    const [first, second] = o.start <= t.start ? [o, t] : [t, o]
    const lines = [
      ...b.slice(0, first.start),
      ...first.lines,
      ...b.slice(first.end, second.start),
      ...second.lines,
      ...b.slice(second.end),
    ]
    return { clean: true, text: lines.join('\n') }
  }

  const start = Math.min(o.start, t.start)
  const end = Math.max(o.end, t.end)
  const mine = sideSpan(b, o, start, end)
  const yours = sideSpan(b, t, start, end)
  if (mine.join('\n') === yours.join('\n')) {
    return { clean: true, text: [...b.slice(0, start), ...mine, ...b.slice(end)].join('\n') }
  }
  const withMarkers = [
    ...b.slice(0, start),
    '<<<<<<< mine',
    ...mine,
    '=======',
    ...yours,
    '>>>>>>> theirs',
    ...b.slice(end),
  ].join('\n')
  return { clean: false, withMarkers }
}

export function hasConflictMarkers(text: string): boolean {
  return /^<<<<<<< /m.test(text) && /^>>>>>>> /m.test(text)
}
