// Today's tiles and edit mode (ARCHITECTURE §16.4, plan E1–E4): two columns of tiles the member
// picks, moves and removes. The layout logic is in @hearth/format; this file only draws it.

import {
  addableTiles,
  addTile,
  moveTile,
  nudgeTile,
  removeTile,
  switchColumn,
  type TodayLayout,
  type TodayTile,
  type TodayTileKind,
  updateTile,
} from '@hearth/format'
import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react'
import type { TaskView } from '../../api/tasks'
import type { TodayView } from '../../api/today'
import { Icon, type IconName } from '../../components/Icon'
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
  }

export interface TodayTilesProps {
  layout: TodayLayout
  view: TodayView
  now: Date
  /** Changes each time Today reloads, so tiles with their own data reload too. */
  refresh: number
  editing: boolean
  onChange: (layout: TodayLayout) => void
  onTaskDone: (task: TaskView) => void
  onTaskAdded: (task: TaskView) => void
}

export function TodayTiles(props: TodayTilesProps) {
  const { layout, editing, onChange } = props
  const [dragging, setDragging] = useState<string | null>(null)

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
            return (
              <EditFrame
                key={tile.id}
                tile={tile}
                first={index === 0}
                last={index === layout.columns[column].length - 1}
                column={column}
                onDragStart={() => setDragging(tile.id)}
                onDragEnd={() => setDragging(null)}
                onDropHere={() => drop(column, index)}
                onUp={() => onChange(nudgeTile(layout, tile.id, -1))}
                onDown={() => onChange(nudgeTile(layout, tile.id, 1))}
                onAcross={() => onChange(switchColumn(layout, tile.id))}
                onRemove={() => onChange(removeTile(layout, tile.id))}
              >
                {body ?? <Placeholder tile={tile} />}
              </EditFrame>
            )
          })}
          {editing && layout.columns[column].length === 0 ? (
            <div className="rounded-2xl border border-dashed border-ash-strong px-4 py-8 text-center text-sm text-ink-faint">
              Drag a tile here
            </div>
          ) : null}
        </div>
      ))}
    </div>
  )
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
  children,
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
  children: ReactNode
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
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag and drop is a pointer extra; the buttons do the same by keyboard
    <div
      data-testid="today-edit-tile"
      data-tile-id={tile.id}
      draggable
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
      className={`rounded-2xl border-2 border-dashed p-1 ${over ? 'border-ember' : 'border-ash-strong'}`}
    >
      <div className="flex items-center gap-1 px-2 pt-1 pb-2">
        <span className="cursor-grab text-ink-faint" title="Drag to move" aria-hidden="true">
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
        <button
          type="button"
          className={`${tool} w-auto px-2 text-xs`}
          onClick={onAcross}
          aria-label={`Move ${label} to the ${column === 0 ? 'right' : 'left'} column`}
          data-testid="today-tile-across"
        >
          Other column
        </button>
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
        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-ash-strong px-3 text-sm text-ink hover:border-ember"
      >
        <Icon name="plus" className="size-4" />
        Add tile
      </button>
      {open ? (
        <ul
          className="absolute right-0 z-20 mt-2 max-h-[60vh] w-72 overflow-y-auto rounded-xl border border-ash bg-paper-raised p-1 shadow-lg"
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
