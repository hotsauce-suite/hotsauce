// Today's tiles and edit mode (ARCHITECTURE §16.4, plan E1–E4): two columns of tiles the member
// picks, moves and removes. The layout logic is in @hotsauce/format; this file only draws it.

import {
  addableTiles,
  addTile,
  layoutTiles,
  moveTile,
  moveTileNextTo,
  nudgeTile,
  nudgeTileStacked,
  removeTile,
  switchColumn,
  type TodayLayout,
  type TodayTile,
  type TodayTileKind,
  updateTile,
} from '@hotsauce/format'
import {
  Fragment,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { TaskView } from '../../api/tasks'
import type { TodayView } from '../../api/today'
import { Icon, type IconName } from '../../components/Icon'
import { TOUCH_QUERY, useMediaQuery } from '../../hooks/useMediaQuery'
import { Card } from './tiles/Card'
import { CheckinsTile } from './tiles/CheckinsTile'
import { ActionItemsCard, DocsCard, MeetingsCard, NotesCard, TasksCard } from './tiles/DayTiles'
import {
  BoardTile,
  BriefTile,
  ClipTile,
  DictateTile,
  FilesTile,
  PeopleTile,
  StarredTile,
  WeekTile,
} from './tiles/MoreTiles'
import { StartTile } from './tiles/StartTile'

export const TILE_CATALOG: Record<TodayTileKind, { label: string; icon: IconName; about: string }> =
  {
    checkins: {
      label: 'Check-in',
      icon: 'checklist',
      about: 'Check-in questions waiting for your answer',
    },
    meetings: { label: 'Meetings', icon: 'calendar', about: 'Today’s meetings, with Take notes' },
    tasks: { label: 'Tasks', icon: 'tasks', about: 'Due today and overdue, and a quick add' },
    'action-items': {
      label: 'From your meetings',
      icon: 'checklist',
      about: 'Meeting to-dos that aren’t tasks yet',
    },
    notes: { label: 'Unfiled notes', icon: 'notes', about: 'Quick notes from the last day' },
    docs: { label: 'Docs changed', icon: 'docs', about: 'Docs changed since yesterday' },
    brief: { label: 'Agent brief', icon: 'sparkle', about: 'A link to what you’re working on' },
    starred: { label: 'Starred', icon: 'star', about: 'The docs and files you starred' },
    dictate: { label: 'Dictate', icon: 'mic', about: 'One click to start dictating' },
    clip: { label: 'Record a clip', icon: 'video', about: 'One click to record your screen' },
    people: { label: 'People', icon: 'people', about: 'The people you meet with' },
    files: { label: 'Recent files', icon: 'folder', about: 'Files added or changed lately' },
    board: { label: 'Board', icon: 'board', about: 'One of your whiteboards' },
    week: {
      label: 'This week',
      icon: 'calendar',
      about: 'Monday to Sunday: meetings and due tasks',
    },
    start: { label: 'Getting started', icon: 'flag', about: 'The first few things worth doing' },
  }

/** Below Tailwind's `lg`, the two columns stack into one list: the left column, then the right. */
export const STACKED_QUERY = '(max-width: 1023px)'

export interface TodayTilesProps {
  layout: TodayLayout
  view: TodayView
  now: Date
  /** Changes each time Today reloads, so tiles with their own data reload too. */
  refresh: number
  editing: boolean
  onChange: (layout: TodayLayout) => void
  /** Every Getting started step is done: save it away, keeping it on screen for this visit. */
  onStartFinished: (tile: TodayTile) => void
  onTaskDone: (task: TaskView) => void
  onTaskAdded: (task: TaskView) => void
}

export function TodayTiles(props: TodayTilesProps) {
  const { layout, editing, onChange } = props
  const [dragging, setDragging] = useState<string | null>(null)
  // On a phone the columns read as one list, so the arrows and dragging treat them as one.
  const stacked = useMediaQuery(STACKED_QUERY)
  const order = layoutTiles(layout).map((t) => t.id)
  const touch = useTouchDrag((id, target, side) =>
    onChange(moveTileNextTo(layout, id, target, side)),
  )

  const held = layoutTiles(layout).find((t) => t.id === touch.dragging)

  // Crossing the column break remounts a tile's frame, which drops keyboard focus: put it back
  // on the same button of the moved tile (or its other arrow, once that one is disabled).
  const refocus = useRef<{ id: string; button: string } | null>(null)
  const moved = (next: TodayLayout, id: string, button: string) => {
    refocus.current = { id, button }
    onChange(next)
  }
  useEffect(() => {
    const want = refocus.current
    if (!want) return
    refocus.current = null
    const frame = document.querySelector(`[data-tile-id="${CSS.escape(want.id)}"]`)
    if (!frame || frame.contains(document.activeElement)) return
    const buttons = [want.button, 'today-tile-up', 'today-tile-down'].map((b) =>
      frame.querySelector<HTMLButtonElement>(`[data-testid="${b}"]`),
    )
    buttons.find((b) => b && !b.disabled)?.focus()
  })

  const drop = (column: 0 | 1, index: number) => {
    if (dragging) onChange(moveTile(layout, dragging, { column, index }))
    setDragging(null)
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[3fr_2fr]" data-testid="today-tiles">
      {([0, 1] as const).map((column) => (
        // biome-ignore lint/a11y/noStaticElementInteractions: dropping at a column's end; the buttons move tiles by keyboard
        <div
          key={column}
          className="flex min-w-0 flex-col gap-5"
          data-testid={`today-column-${column}`}
          onDragOver={editing ? (e) => e.preventDefault() : undefined}
          onDrop={
            editing
              ? (e) => {
                  e.preventDefault()
                  drop(column, layout.columns[column].length)
                }
              : undefined
          }
        >
          {layout.columns[column].map((tile, index) => {
            const body = hiddenToday(tile, props.view) ? null : <TileBody tile={tile} {...props} />
            // No wrapper: a tile that renders nothing must leave no gap in the column.
            if (!editing) return body ? <Fragment key={tile.id}>{body}</Fragment> : null
            const at = order.indexOf(tile.id)
            return (
              <EditFrame
                key={tile.id}
                tile={tile}
                first={stacked ? at === 0 : index === 0}
                last={
                  stacked ? at === order.length - 1 : index === layout.columns[column].length - 1
                }
                column={column}
                stacked={stacked}
                lifted={touch.dragging === tile.id}
                marker={touch.over?.id === tile.id ? touch.over.side : null}
                onGripDown={(e) => touch.start(e, tile.id)}
                onDragStart={() => setDragging(tile.id)}
                onDragEnd={() => setDragging(null)}
                onDropHere={() => drop(column, index)}
                onUp={() =>
                  moved(
                    stacked
                      ? nudgeTileStacked(layout, tile.id, -1)
                      : nudgeTile(layout, tile.id, -1),
                    tile.id,
                    'today-tile-up',
                  )
                }
                onDown={() =>
                  moved(
                    stacked ? nudgeTileStacked(layout, tile.id, 1) : nudgeTile(layout, tile.id, 1),
                    tile.id,
                    'today-tile-down',
                  )
                }
                onAcross={() => moved(switchColumn(layout, tile.id), tile.id, 'today-tile-across')}
                onRemove={() => onChange(removeTile(layout, tile.id))}
              >
                {body ?? <Placeholder tile={tile} />}
              </EditFrame>
            )
          })}
          {editing && !stacked && layout.columns[column].length === 0 ? (
            <div className="rounded-2xl border border-dashed border-ash-strong px-4 py-8 text-center text-sm text-ink-faint">
              Drag a tile here
            </div>
          ) : null}
        </div>
      ))}
      {held && touch.finger ? (
        // The tile's name follows the finger, since the tile itself may scroll out of view.
        <div
          aria-hidden="true"
          data-testid="today-drag-ghost"
          className="pointer-events-none fixed z-50 flex items-center gap-2 rounded-xl border border-ember bg-paper-raised px-3 py-2 text-sm font-medium text-ink shadow-lg"
          style={{ left: touch.finger.x + 12, top: touch.finger.y - 20 }}
        >
          <Icon name="grip" className="size-4 text-ink-faint" />
          {TILE_CATALOG[held.kind].label}
        </div>
      ) : null}
    </div>
  )
}

/** How close to the top or bottom of the page a dragged tile starts it scrolling, in pixels. */
const EDGE_PX = 80
/** The most it scrolls in one frame, right at the edge. */
const MAX_SCROLL_PX = 18

/**
 * Dragging a tile by its handle with a finger (or a pen). Browsers don't do HTML drag and drop
 * from touch reliably, so this follows the pointer itself: the tile under the finger shows where
 * the dragged one will land, the page scrolls near its top and bottom edges, and letting go moves
 * it there. A mouse keeps the browser's own drag and drop.
 */
function useTouchDrag(onDrop: (id: string, target: string, side: 'before' | 'after') => void) {
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<{ id: string; side: 'before' | 'after' } | null>(null)
  const [finger, setFinger] = useState<{ x: number; y: number } | null>(null)
  const state = useRef<{
    id: string
    pointer: number
    x: number
    y: number
    over: { id: string; side: 'before' | 'after' } | null
    scroller: HTMLElement | null
    frame: number
  } | null>(null)
  const dropRef = useRef(onDrop)
  dropRef.current = onDrop

  useEffect(() => {
    if (!dragging) return
    const aim = () => {
      const s = state.current
      if (!s) return
      const el = document.elementFromPoint(s.x, s.y)?.closest<HTMLElement>('[data-tile-id]')
      const id = el?.dataset.tileId
      // In the gaps between tiles, or over the edit bar, the last aim holds, so letting go there
      // still lands. Over the dragged tile itself, it would land where it already is.
      if (!el || !id) return
      let next: typeof s.over = null
      if (id !== s.id) {
        const box = el.getBoundingClientRect()
        next = { id, side: s.y < box.top + box.height / 2 ? 'before' : 'after' }
      }
      if (next?.id !== s.over?.id || next?.side !== s.over?.side) {
        s.over = next
        setOver(next)
      }
    }
    const scroll = () => {
      const s = state.current
      if (!s) return
      const box = s.scroller?.getBoundingClientRect()
      if (s.scroller && box) {
        // The pinned edit bar covers the top of the page: the edge starts below it.
        const bar = document
          .querySelector('[data-testid="today-edit-bar"]')
          ?.getBoundingClientRect()
        const top = s.y - Math.max(box.top, bar?.bottom ?? box.top)
        const bottom = box.bottom - s.y
        const by =
          top < EDGE_PX
            ? -MAX_SCROLL_PX * (1 - Math.max(0, top) / EDGE_PX)
            : bottom < EDGE_PX
              ? MAX_SCROLL_PX * (1 - Math.max(0, bottom) / EDGE_PX)
              : 0
        if (by !== 0) {
          s.scroller.scrollTop += by
          aim()
        }
      }
      s.frame = requestAnimationFrame(scroll)
    }
    const move = (e: PointerEvent) => {
      const s = state.current
      if (!s || e.pointerId !== s.pointer) return
      e.preventDefault()
      s.x = e.clientX
      s.y = e.clientY
      setFinger({ x: s.x, y: s.y })
      aim()
    }
    const end = (e: PointerEvent) => {
      const s = state.current
      if (!s || e.pointerId !== s.pointer) return
      cancelAnimationFrame(s.frame)
      state.current = null
      setDragging(null)
      setOver(null)
      setFinger(null)
      if (e.type === 'pointerup' && s.over) dropRef.current(s.id, s.over.id, s.over.side)
    }
    if (state.current) state.current.frame = requestAnimationFrame(scroll)
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => {
      if (state.current) cancelAnimationFrame(state.current.frame)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
  }, [dragging])

  return {
    dragging,
    over,
    finger,
    start: (e: ReactPointerEvent, id: string) => {
      if (e.pointerType === 'mouse') return
      e.preventDefault()
      const scroller = (e.currentTarget as HTMLElement).closest<HTMLElement>(
        '[data-today-scroller]',
      )
      state.current = {
        id,
        pointer: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        over: null,
        scroller,
        frame: 0,
      }
      setFinger({ x: e.clientX, y: e.clientY })
      setDragging(id)
    },
  }
}

/** Tiles that hide on a day they have nothing to show; edit mode shows a placeholder instead. */
function hiddenToday(tile: TodayTile, view: TodayView): boolean {
  if (tile.kind === 'action-items') return view.actionItems.length === 0
  if (tile.kind === 'notes') return view.notes.length === 0
  return false
}

/** A tile's content. */
function TileBody({
  tile,
  view,
  now,
  refresh,
  editing,
  layout,
  onChange,
  onStartFinished,
  onTaskDone,
  onTaskAdded,
}: TodayTilesProps & { tile: TodayTile }): ReactNode {
  switch (tile.kind) {
    case 'checkins':
      return <CheckinsTile editing={editing} />
    case 'meetings':
      return <MeetingsCard meetings={view.meetings} now={now} />
    case 'tasks':
      return (
        <TasksCard tasks={view.tasks} date={view.date} onDone={onTaskDone} onAdded={onTaskAdded} />
      )
    case 'action-items':
      return <ActionItemsCard view={view} />
    case 'notes':
      return <NotesCard notes={view.notes} now={now} />
    case 'docs':
      return <DocsCard docs={view.docs} now={now} />
    case 'brief':
      return <BriefTile />
    case 'starred':
      return <StarredTile />
    case 'dictate':
      return <DictateTile />
    case 'clip':
      return <ClipTile />
    case 'people':
      return <PeopleTile refresh={refresh} />
    case 'files':
      return <FilesTile now={now} refresh={refresh} />
    case 'board':
      return (
        <BoardTile
          tile={tile}
          now={now}
          refresh={refresh}
          onChoose={(board) => onChange(updateTile(layout, { ...tile, board }))}
        />
      )
    case 'week':
      return <WeekTile now={now} refresh={refresh} />
    case 'start':
      return (
        <StartTile
          tile={tile}
          layout={layout}
          view={view}
          editing={editing}
          onChange={onChange}
          onFinished={onStartFinished}
        />
      )
  }
}

function Placeholder({ tile }: { tile: TodayTile }) {
  const info = TILE_CATALOG[tile.kind]
  return (
    <Card title={info.label} icon={info.icon} testId={`today-placeholder-${tile.kind}`}>
      <p className="text-sm text-ink-faint">Nothing here today, so this tile is hidden.</p>
    </Card>
  )
}

const tool =
  'flex size-8 items-center justify-center rounded-md text-ink-soft hover:bg-paper-sunk hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent'

function EditFrame({
  tile,
  first,
  last,
  column,
  stacked,
  lifted,
  marker,
  children,
  onGripDown,
  onDragStart,
  onDragEnd,
  onDropHere,
  onUp,
  onDown,
  onAcross,
  onRemove,
}: {
  tile: TodayTile
  first: boolean
  last: boolean
  column: 0 | 1
  /** One list on a phone: no "Other column", since the arrows already cross it. */
  stacked: boolean
  /** Being dragged by touch. */
  lifted: boolean
  /** Where a tile dragged by touch would land, next to this one. */
  marker: 'before' | 'after' | null
  children: ReactNode
  onGripDown: (e: ReactPointerEvent) => void
  onDragStart: () => void
  onDragEnd: () => void
  onDropHere: () => void
  onUp: () => void
  onDown: () => void
  onAcross: () => void
  onRemove: () => void
}) {
  const label = TILE_CATALOG[tile.kind].label
  const picking = tile.kind === 'board' && !tile.board
  const [over, setOver] = useState(false)
  // A finger drags by the handle instead (useTouchDrag); a long press mustn't start the browser's.
  const coarse = useMediaQuery(TOUCH_QUERY)
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag and drop is a pointer extra; the buttons do the same by keyboard
    <div
      data-testid="today-edit-tile"
      data-tile-id={tile.id}
      draggable={!coarse}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', tile.id)
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setOver(false)
        onDropHere()
      }}
      className={`relative rounded-2xl border-2 border-dashed p-1 ${over ? 'border-ember' : 'border-ash-strong'} ${lifted ? 'opacity-50' : ''}`}
    >
      {marker ? (
        <div
          aria-hidden="true"
          data-testid="today-drop-marker"
          data-side={marker}
          className={`pointer-events-none absolute inset-x-2 h-1 rounded-full bg-ember ${marker === 'before' ? '-top-3' : '-bottom-3'}`}
        />
      ) : null}
      {/* No text selection or iOS callout from a long press here: either would cancel a drag. */}
      <div className="flex items-center gap-1 px-1 pt-1 pb-2 select-none [-webkit-touch-callout:none]">
        {/* A finger drags from here; the page still scrolls from anywhere else. */}
        <span
          className="-my-1 flex size-9 cursor-grab touch-none items-center justify-center rounded-md text-ink-faint"
          title="Drag to move"
          aria-hidden="true"
          data-testid="today-tile-grip"
          onPointerDown={onGripDown}
        >
          <Icon name="grip" className="size-4" />
        </span>
        <span className="flex-1 text-xs font-medium text-ink-soft">{label}</span>
        <button
          type="button"
          className={tool}
          onClick={onUp}
          disabled={first}
          aria-label={`Move ${label} up`}
          data-testid="today-tile-up"
        >
          <Icon name="chevron" className="size-4 -rotate-90" />
        </button>
        <button
          type="button"
          className={tool}
          onClick={onDown}
          disabled={last}
          aria-label={`Move ${label} down`}
          data-testid="today-tile-down"
        >
          <Icon name="chevron" className="size-4 rotate-90" />
        </button>
        {stacked ? null : (
          <button
            type="button"
            className={`${tool} w-auto px-2 text-xs`}
            onClick={onAcross}
            aria-label={`Move ${label} to the ${column === 0 ? 'right' : 'left'} column`}
            data-testid="today-tile-across"
          >
            Other column
          </button>
        )}
        <button
          type="button"
          className={tool}
          onClick={onRemove}
          aria-label={`Remove ${label}`}
          data-testid="today-tile-remove"
        >
          <Icon name="close" className="size-4" />
        </button>
      </div>
      {/* Arranging, not using: no clicks, no keyboard focus. An unpicked Board still asks. */}
      <div inert={!picking} className={picking ? '' : 'select-none'}>
        {children}
      </div>
    </div>
  )
}

/** E1: "+ Add tile" and its list. */
export function AddTileMenu({
  layout,
  onChange,
}: {
  layout: TodayLayout
  onChange: (layout: TodayLayout) => void
}) {
  const [open, setOpen] = useState(false)
  const kinds = addableTiles(layout)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    box.current
      ?.querySelector<HTMLButtonElement>('[data-testid="today-add-tile-menu"] button')
      ?.focus()
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', key)
    }
  }, [open])
  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-testid="today-add-tile"
        className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg border border-ash-strong px-2.5 text-sm text-ink hover:border-ember sm:px-3"
      >
        <Icon name="plus" className="size-4" />
        Add tile
      </button>
      {open ? (
        <ul
          className="absolute left-0 z-20 mt-2 max-h-[60vh] w-72 overflow-y-auto rounded-xl border border-ash bg-paper-raised p-1 shadow-lg"
          data-testid="today-add-tile-menu"
        >
          {kinds.length === 0 ? (
            <li className="px-3 py-2 text-sm text-ink-faint">
              Today is full. Remove a tile first.
            </li>
          ) : null}
          {kinds.map((kind) => {
            const info = TILE_CATALOG[kind]
            return (
              <li key={kind}>
                <button
                  type="button"
                  data-testid={`today-add-${kind}`}
                  onClick={() => {
                    onChange(addTile(layout, kind))
                    setOpen(false)
                  }}
                  className="flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left hover:bg-paper-sunk"
                >
                  <Icon name={info.icon} className="mt-0.5 size-4 shrink-0 text-ink-faint" />
                  <span>
                    <span className="block text-sm font-medium text-ink">{info.label}</span>
                    <span className="block text-xs text-ink-faint">{info.about}</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
