// The Today layout (ARCHITECTURE §16.4): which tiles a member shows on Today, in which column and
// order. One JSON file per member, `.hearth/today.json` in their personal space. Everything here
// is pure: parsing, serializing and the edits the web app makes in edit mode.

import { z } from 'zod'

export const TODAY_LAYOUT_PATH = '.hearth/today.json'
/** More tiles than this are dropped when a layout is read. */
export const MAX_TODAY_TILES = 40

export const TODAY_TILE_KINDS = [
  'meetings',
  'tasks',
  'action-items',
  'notes',
  'docs',
  'brief',
  'starred',
  'dictate',
  'clip',
  'people',
  'files',
  'board',
  'week',
] as const
export type TodayTileKind = (typeof TODAY_TILE_KINDS)[number]

/** Kinds a layout may hold more than once; each copy has its own settings. */
export const REPEATABLE_TILES: ReadonlySet<TodayTileKind> = new Set(['board'])

export interface TodayTile {
  /** Unique within the layout, so two Board tiles can be told apart. */
  id: string
  kind: TodayTileKind
  /** Board tiles: the board shown, once chosen. */
  board?: { space: string; id: string }
}

export interface TodayLayout {
  schema: 1
  /** Left column, then right. A phone shows the left column first, then the right. */
  columns: [TodayTile[], TodayTile[]]
}

/** Today as it looked before tiles could be changed. */
export function defaultTodayLayout(): TodayLayout {
  return {
    schema: 1,
    columns: [
      [tile('meetings'), tile('tasks'), tile('action-items')],
      [tile('notes'), tile('docs'), tile('brief')],
    ],
  }
}

function tile(kind: TodayTileKind): TodayTile {
  return { id: kind, kind }
}

const TileId = z.string().regex(/^[a-z0-9-]{1,40}$/)
const RawTile = z.looseObject({
  id: z.unknown(),
  kind: z.unknown(),
  board: z.unknown().optional(),
})
const BoardRef = z.object({ space: z.string().min(1).max(200), id: z.string().min(1).max(100) })
const RawLayout = z.looseObject({
  schema: z.literal(1),
  columns: z.tuple([z.array(z.unknown()), z.array(z.unknown())]),
})

export class TodayLayoutError extends Error {}

/**
 * Reads a layout from the file's text or from a request body. A tile that isn't understood (an
 * unknown kind from a newer version, a second copy of a single-use tile, a repeated id) is
 * dropped rather than failing the whole layout. Something that isn't a layout at all throws.
 */
export function parseTodayLayout(input: string | unknown): TodayLayout {
  let data: unknown = input
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input)
    } catch {
      throw new TodayLayoutError(`${TODAY_LAYOUT_PATH} isn't valid JSON`)
    }
  }
  const raw = RawLayout.safeParse(data)
  if (!raw.success) throw new TodayLayoutError(`${TODAY_LAYOUT_PATH} isn't a Today layout`)
  const kinds = new Set<string>()
  const ids = new Set<string>()
  let count = 0
  const column = (items: unknown[]): TodayTile[] => {
    const out: TodayTile[] = []
    for (const item of items) {
      if (count >= MAX_TODAY_TILES) break
      const t = RawTile.safeParse(item)
      if (!t.success) continue
      const id = TileId.safeParse(t.data.id)
      const kind = t.data.kind as TodayTileKind
      if (!id.success || !TODAY_TILE_KINDS.includes(kind)) continue
      if (ids.has(id.data)) continue
      if (kinds.has(kind) && !REPEATABLE_TILES.has(kind)) continue
      const board = BoardRef.safeParse(t.data.board)
      ids.add(id.data)
      kinds.add(kind)
      count++
      out.push(
        kind === 'board' && board.success
          ? { id: id.data, kind, board: board.data }
          : { id: id.data, kind },
      )
    }
    return out
  }
  return { schema: 1, columns: [column(raw.data.columns[0]), column(raw.data.columns[1])] }
}

/** The file's text: stable key order, two-space indent, a trailing newline. */
export function serializeTodayLayout(layout: TodayLayout): string {
  const clean = parseTodayLayout(layout)
  return `${JSON.stringify(clean, null, 2)}\n`
}

/** Every tile, left column first. */
export function layoutTiles(layout: TodayLayout): TodayTile[] {
  return [...layout.columns[0], ...layout.columns[1]]
}

/** Kinds the "+ Add tile" picker offers: those not shown yet, and the repeatable ones. */
export function addableTiles(layout: TodayLayout): TodayTileKind[] {
  const shown = new Set(layoutTiles(layout).map((t) => t.kind))
  return TODAY_TILE_KINDS.filter((k) => REPEATABLE_TILES.has(k) || !shown.has(k))
}

/** Adds a tile to the end of the shorter column (the left one on a tie). */
export function addTile(layout: TodayLayout, kind: TodayTileKind): TodayLayout {
  if (!addableTiles(layout).includes(kind)) return layout
  const ids = new Set(layoutTiles(layout).map((t) => t.id))
  let id: string = kind
  for (let n = 2; ids.has(id); n++) id = `${kind}-${n}`
  const [left, right] = layout.columns
  const target = right.length < left.length ? 1 : 0
  return withColumn(layout, target, [...layout.columns[target], { id, kind }])
}

export function removeTile(layout: TodayLayout, id: string): TodayLayout {
  return {
    schema: 1,
    columns: [
      layout.columns[0].filter((t) => t.id !== id),
      layout.columns[1].filter((t) => t.id !== id),
    ],
  }
}

/** Replaces one tile's settings, e.g. the board a Board tile shows. */
export function updateTile(layout: TodayLayout, next: TodayTile): TodayLayout {
  const swap = (c: TodayTile[]) => c.map((t) => (t.id === next.id ? next : t))
  return { schema: 1, columns: [swap(layout.columns[0]), swap(layout.columns[1])] }
}

/** Where a tile is, or null. */
export function findTile(layout: TodayLayout, id: string): { column: 0 | 1; index: number } | null {
  for (const column of [0, 1] as const) {
    const index = layout.columns[column].findIndex((t) => t.id === id)
    if (index >= 0) return { column, index }
  }
  return null
}

/**
 * Moves a tile to `column` at `index` (counted in the column as it is without the tile). An index
 * past the end puts it last. Used by drag and drop and by the arrow buttons.
 */
export function moveTile(
  layout: TodayLayout,
  id: string,
  to: { column: 0 | 1; index: number },
): TodayLayout {
  const from = findTile(layout, id)
  if (!from) return layout
  const moving = layout.columns[from.column][from.index] as TodayTile
  const without = removeTile(layout, id)
  const target = [...without.columns[to.column]]
  target.splice(Math.max(0, Math.min(to.index, target.length)), 0, moving)
  return withColumn(without, to.column, target)
}

/** One step up or down within its column. Off either end does nothing. */
export function nudgeTile(layout: TodayLayout, id: string, step: -1 | 1): TodayLayout {
  const at = findTile(layout, id)
  if (!at) return layout
  const index = at.index + step
  if (index < 0 || index >= layout.columns[at.column].length) return layout
  return moveTile(layout, id, { column: at.column, index })
}

/** To the end of the other column. */
export function switchColumn(layout: TodayLayout, id: string): TodayLayout {
  const at = findTile(layout, id)
  if (!at) return layout
  const other = at.column === 0 ? 1 : 0
  return moveTile(layout, id, { column: other, index: layout.columns[other].length })
}

function withColumn(layout: TodayLayout, column: 0 | 1, tiles: TodayTile[]): TodayLayout {
  return {
    schema: 1,
    columns: column === 0 ? [tiles, layout.columns[1]] : [layout.columns[0], tiles],
  }
}
