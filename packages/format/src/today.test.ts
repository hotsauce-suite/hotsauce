import { describe, expect, it } from 'vitest'
import {
  addableTiles,
  addTile,
  defaultTodayLayout,
  layoutTiles,
  MAX_TODAY_TILES,
  moveTile,
  moveTileNextTo,
  nudgeTile,
  nudgeTileStacked,
  offerGettingStarted,
  parseTodayLayout,
  removeTile,
  serializeTodayLayout,
  showGettingStarted,
  switchColumn,
  TODAY_TILE_KINDS,
  type TodayLayout,
  TodayLayoutError,
  updateTile,
} from './today.js'

const ids = (l: TodayLayout) => l.columns.map((c) => c.map((t) => t.id))

describe('Today layout file (L1)', () => {
  it('round-trips the default layout', () => {
    const text = serializeTodayLayout(defaultTodayLayout())
    expect(text.endsWith('\n')).toBe(true)
    // Saved without the Getting started tile, so it is marked as dealt with (F2).
    expect(parseTodayLayout(text)).toEqual({ ...defaultTodayLayout(), gettingStarted: 'dismissed' })
  })

  it('throws on text that is not a layout', () => {
    expect(() => parseTodayLayout('nope')).toThrow(TodayLayoutError)
    expect(() => parseTodayLayout('{"schema":2,"columns":[[],[]]}')).toThrow(TodayLayoutError)
    expect(() => parseTodayLayout({ schema: 1, columns: [[]] })).toThrow(TodayLayoutError)
  })

  it('drops unknown kinds, bad ids, duplicate single-use tiles and repeated ids', () => {
    const layout = parseTodayLayout({
      schema: 1,
      columns: [
        [
          { id: 'tasks', kind: 'tasks' },
          { id: 'tasks-2', kind: 'tasks' },
          { id: 'x', kind: 'weather-radar' },
          { id: 'Bad Id', kind: 'docs' },
          'not a tile',
        ],
        [
          { id: 'board', kind: 'board', board: { space: 'team', id: 'b1' } },
          { id: 'board-2', kind: 'board', board: { space: 7 } },
          { id: 'board', kind: 'week' },
        ],
      ],
    })
    expect(layout.columns[0]).toEqual([{ id: 'tasks', kind: 'tasks' }])
    expect(layout.columns[1]).toEqual([
      { id: 'board', kind: 'board', board: { space: 'team', id: 'b1' } },
      { id: 'board-2', kind: 'board' },
    ])
  })

  it(`keeps at most ${MAX_TODAY_TILES} tiles`, () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `b${i}`, kind: 'board' }))
    const layout = parseTodayLayout({ schema: 1, columns: [many, many] })
    expect(layout.columns[0].length + layout.columns[1].length).toBe(MAX_TODAY_TILES)
  })
})

describe('Today layout edits (E1, E2)', () => {
  it('offers only tiles not shown yet, plus Board', () => {
    const offered = addableTiles(defaultTodayLayout())
    expect(offered).not.toContain('tasks')
    expect(offered).toContain('starred')
    expect(offered).toContain('board')
    const withBoard = addTile(defaultTodayLayout(), 'board')
    expect(addableTiles(withBoard)).toContain('board')
  })

  it('adds to the shorter column, left on a tie, with a fresh id for a second board', () => {
    let l = defaultTodayLayout()
    l = addTile(l, 'starred')
    expect(ids(l)[1]).toEqual(['notes', 'docs', 'brief', 'starred'])
    l = addTile(l, 'board')
    l = addTile(l, 'board')
    expect(ids(l)[0]).toEqual(['checkins', 'meetings', 'tasks', 'action-items', 'board'])
    expect(ids(l)[1]?.at(-1)).toBe('board-2')
    expect(addTile(l, 'starred')).toBe(l)
  })

  it('every kind can be added to an empty layout, once unless repeatable', () => {
    let l: TodayLayout = { schema: 1, columns: [[], []] }
    for (const kind of TODAY_TILE_KINDS) l = addTile(l, kind)
    expect(l.columns[0].length + l.columns[1].length).toBe(TODAY_TILE_KINDS.length)
    expect(addableTiles(l)).toEqual(['board'])
  })

  it(`offers nothing once Today holds ${MAX_TODAY_TILES} tiles`, () => {
    let l: TodayLayout = { schema: 1, columns: [[], []] }
    for (let i = 0; i < MAX_TODAY_TILES + 5; i++) l = addTile(l, 'board')
    expect(l.columns[0].length + l.columns[1].length).toBe(MAX_TODAY_TILES)
    expect(addableTiles(l)).toEqual([])
  })

  it('removes, nudges, moves across and updates', () => {
    let l = removeTile(defaultTodayLayout(), 'checkins')
    l = nudgeTile(l, 'tasks', -1)
    expect(ids(l)[0]).toEqual(['tasks', 'meetings', 'action-items'])
    expect(nudgeTile(l, 'tasks', -1)).toBe(l)
    l = switchColumn(l, 'tasks')
    expect(ids(l)).toEqual([
      ['meetings', 'action-items'],
      ['notes', 'docs', 'brief', 'tasks'],
    ])
    l = moveTile(l, 'brief', { column: 0, index: 0 })
    expect(ids(l)[0]).toEqual(['brief', 'meetings', 'action-items'])
    l = moveTile(l, 'brief', { column: 0, index: 99 })
    expect(ids(l)[0]).toEqual(['meetings', 'action-items', 'brief'])
    l = removeTile(l, 'docs')
    expect(ids(l)[1]).toEqual(['notes', 'tasks'])
    l = addTile(l, 'board')
    l = updateTile(l, { id: 'board', kind: 'board', board: { space: 'team', id: 'b1' } })
    expect(parseTodayLayout(serializeTodayLayout(l))).toEqual({ ...l, gettingStarted: 'dismissed' })
  })

  it('moving or removing a missing tile changes nothing', () => {
    const l = defaultTodayLayout()
    expect(moveTile(l, 'nope', { column: 1, index: 0 })).toBe(l)
    expect(switchColumn(l, 'nope')).toBe(l)
    expect(ids(removeTile(l, 'nope'))).toEqual(ids(l))
  })

  it('E6: on a phone a tile steps through the whole list, across the column break', () => {
    let l = defaultTodayLayout()
    l = nudgeTileStacked(l, 'action-items', 1)
    expect(ids(l)).toEqual([
      ['checkins', 'meetings', 'tasks', 'notes'],
      ['action-items', 'docs', 'brief'],
    ])
    l = nudgeTileStacked(l, 'action-items', -1)
    expect(ids(l)).toEqual(ids(defaultTodayLayout()))
    l = nudgeTileStacked(l, 'notes', -1)
    expect(ids(l)).toEqual([
      ['checkins', 'meetings', 'tasks', 'notes'],
      ['action-items', 'docs', 'brief'],
    ])
    // The very top and bottom stay put.
    expect(nudgeTileStacked(l, 'checkins', -1)).toBe(l)
    expect(nudgeTileStacked(l, 'brief', 1)).toBe(l)
    expect(nudgeTileStacked(l, 'nope', 1)).toBe(l)
  })

  it('E6: every stacked step swaps with its neighbour in the phone list and keeps column lengths, for any split', () => {
    const all = defaultTodayLayout().columns.flat()
    for (let split = 0; split <= all.length; split++) {
      const l: TodayLayout = { schema: 1, columns: [all.slice(0, split), all.slice(split)] }
      for (let i = 0; i < all.length; i++) {
        for (const step of [-1, 1] as const) {
          const j = i + step
          const want = all.map((t) => t.id)
          if (j >= 0 && j < all.length) [want[i], want[j]] = [want[j] as string, want[i] as string]
          const got = nudgeTileStacked(l, all[i]?.id as string, step)
          expect(layoutTiles(got).map((t) => t.id)).toEqual(want)
          expect(got.columns[0]).toHaveLength(split)
        }
      }
    }
  })

  it('E6: a tile dropped by touch lands just before or after the one under the finger', () => {
    const l = defaultTodayLayout()
    expect(ids(moveTileNextTo(l, 'checkins', 'tasks', 'after'))[0]).toEqual([
      'meetings',
      'tasks',
      'checkins',
      'action-items',
    ])
    expect(ids(moveTileNextTo(l, 'action-items', 'meetings', 'before'))[0]).toEqual([
      'checkins',
      'action-items',
      'meetings',
      'tasks',
    ])
    expect(ids(moveTileNextTo(l, 'brief', 'checkins', 'before'))).toEqual([
      ['brief', 'checkins', 'meetings', 'tasks', 'action-items'],
      ['notes', 'docs'],
    ])
    expect(ids(moveTileNextTo(l, 'checkins', 'brief', 'after'))[1]?.at(-1)).toBe('checkins')
    expect(moveTileNextTo(l, 'tasks', 'tasks', 'after')).toBe(l)
    expect(moveTileNextTo(l, 'tasks', 'nope', 'after')).toBe(l)
    expect(moveTileNextTo(l, 'nope', 'tasks', 'after')).toBe(l)
  })

  it('E6: dropping next to any tile puts it exactly there, for every pair', () => {
    const l = defaultTodayLayout()
    const all = layoutTiles(l).map((t) => t.id)
    for (const id of all)
      for (const target of all) {
        if (id === target) continue
        for (const side of ['before', 'after'] as const) {
          const got = layoutTiles(moveTileNextTo(l, id, target, side)).map((t) => t.id)
          const want = all.filter((x) => x !== id)
          want.splice(want.indexOf(target) + (side === 'after' ? 1 : 0), 0, id)
          expect(got).toEqual(want)
        }
      }
  })
})

describe('Getting started tile (PLAN-getting-started F1–F3)', () => {
  const start = { id: 'start', kind: 'start' } as const

  it('F1: a start tile keeps openedDocs; other kinds drop it', () => {
    const layout = parseTodayLayout({
      schema: 1,
      columns: [
        [
          { id: 'start', kind: 'start', openedDocs: true },
          { id: 'tasks', kind: 'tasks', openedDocs: true },
        ],
        [{ id: 'start-2', kind: 'start' }],
      ],
    })
    expect(layout.columns[0]).toEqual([
      { id: 'start', kind: 'start', openedDocs: true },
      { id: 'tasks', kind: 'tasks' },
    ])
    // Single-use.
    expect(layout.columns[1]).toEqual([])
    expect(
      parseTodayLayout({
        schema: 1,
        columns: [[{ id: 'start', kind: 'start', openedDocs: 'yes' }], []],
      }).columns[0],
    ).toEqual([start])
  })

  it('F2: a layout saved without the tile is marked dismissed; with it, not', () => {
    const without = JSON.parse(serializeTodayLayout(defaultTodayLayout()))
    expect(without.gettingStarted).toBe('dismissed')
    expect(parseTodayLayout(without).gettingStarted).toBe('dismissed')

    const withTile = offerGettingStarted(defaultTodayLayout())
    const saved = JSON.parse(serializeTodayLayout({ ...withTile, gettingStarted: 'dismissed' }))
    expect('gettingStarted' in saved).toBe(false)
    expect(parseTodayLayout(saved).gettingStarted).toBeUndefined()
    // A mark that isn't ours is ignored.
    expect(
      parseTodayLayout({ schema: 1, columns: [[], []], gettingStarted: 'later' }).gettingStarted,
    ).toBeUndefined()
  })

  it('F3: the tile is offered first on the left, once', () => {
    const offered = offerGettingStarted(defaultTodayLayout())
    expect(offered.columns[0][0]).toEqual(start)
    expect(ids(offered)[0]?.slice(1)).toEqual(ids(defaultTodayLayout())[0])
    expect(offered.columns[1]).toEqual(defaultTodayLayout().columns[1])
    expect(offerGettingStarted(offered)).toEqual(offered)
  })

  it('F3: a layout from before the feature gets the offer; a dismissed one does not', () => {
    const old = parseTodayLayout({ schema: 1, columns: [[{ id: 'tasks', kind: 'tasks' }], []] })
    expect(ids(offerGettingStarted(old))).toEqual([['start', 'tasks'], []])
    const hidden = parseTodayLayout(serializeTodayLayout(old))
    expect(offerGettingStarted(hidden)).toEqual(hidden)
  })

  it('F3: a full layout is left alone', () => {
    let full: TodayLayout = { schema: 1, columns: [[], []] }
    for (let i = 0; i < MAX_TODAY_TILES; i++)
      full = { schema: 1, columns: [[...full.columns[0], { id: `board-${i}`, kind: 'board' }], []] }
    expect(offerGettingStarted(full)).toEqual(full)
    expect(showGettingStarted(full)).toEqual(full)
  })

  it('F3: replay puts a fresh tile back even after it was dismissed, and leaves a shown one alone', () => {
    const hidden = parseTodayLayout(serializeTodayLayout(defaultTodayLayout()))
    const again = showGettingStarted(hidden)
    expect(again.columns[0][0]).toEqual(start)
    expect(again.gettingStarted).toBeUndefined()
    const used = updateTile(again, { id: 'start', kind: 'start', openedDocs: true })
    expect(showGettingStarted(used)).toEqual(used)
  })

  it('hiding it and saving keeps it hidden through a round trip', () => {
    const offered = offerGettingStarted(defaultTodayLayout())
    const hidden = removeTile(offered, 'start')
    const reread = parseTodayLayout(serializeTodayLayout(hidden))
    expect(layoutTiles(offerGettingStarted(reread)).some((t) => t.kind === 'start')).toBe(false)
    // It can still be added back by hand.
    expect(addableTiles(reread)).toContain('start')
  })
})
