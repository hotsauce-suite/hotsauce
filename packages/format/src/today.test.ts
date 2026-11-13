import { describe, expect, it } from 'vitest'
import {
  addableTiles,
  addTile,
  defaultTodayLayout,
  MAX_TODAY_TILES,
  moveTile,
  nudgeTile,
  parseTodayLayout,
  removeTile,
  serializeTodayLayout,
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
    expect(parseTodayLayout(text)).toEqual(defaultTodayLayout())
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
    expect(ids(l)[0]).toEqual(['meetings', 'tasks', 'action-items', 'starred'])
    l = addTile(l, 'board')
    l = addTile(l, 'board')
    expect(ids(l)[1]).toEqual(['notes', 'docs', 'brief', 'board'])
    expect(ids(l)[0]?.at(-1)).toBe('board-2')
    expect(addTile(l, 'starred')).toBe(l)
  })

  it('every kind can be added to an empty layout, once unless repeatable', () => {
    let l: TodayLayout = { schema: 1, columns: [[], []] }
    for (const kind of TODAY_TILE_KINDS) l = addTile(l, kind)
    expect(l.columns[0].length + l.columns[1].length).toBe(TODAY_TILE_KINDS.length)
    expect(addableTiles(l)).toEqual(['board'])
  })

  it('removes, nudges, moves across and updates', () => {
    let l = defaultTodayLayout()
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
    expect(parseTodayLayout(serializeTodayLayout(l))).toEqual(l)
  })

  it('moving or removing a missing tile changes nothing', () => {
    const l = defaultTodayLayout()
    expect(moveTile(l, 'nope', { column: 1, index: 0 })).toBe(l)
    expect(switchColumn(l, 'nope')).toBe(l)
    expect(ids(removeTile(l, 'nope'))).toEqual(ids(l))
  })
})
