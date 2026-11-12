import { type PointerEvent as ReactPointerEvent, useRef, useState } from 'react'
import { type TaskPerson, type TaskView, taskKey } from '../../api/tasks'
import { dropIndex } from './logic'
import { TaskRow } from './TaskRow'

interface Drag {
  from: number
  to: number
  offset: number
  height: number
}

export interface TaskListProps {
  tasks: TaskView[]
  today: string
  now: Date
  selectedKey: string | null
  leaving: ReadonlySet<string>
  showProject: boolean
  people: readonly TaskPerson[]
  onToggle: (task: TaskView) => void
  onOpen: (task: TaskView) => void
  onSelect: (task: TaskView) => void
  /** Present where the member orders by hand: a row dragged from `from` to `to`. */
  onReorder?: ((from: number, to: number) => void) | undefined
  label: string
}

/**
 * A card of task rows. Where the list is ordered by hand, each row has a grip: pointer events
 * (mouse, pen and touch alike) drag it, the rows it passes make room, and dropping it reports
 * the move; the caller writes the new `order`.
 */
export function TaskList(props: TaskListProps) {
  const listRef = useRef<HTMLUListElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)

  const startDrag = (index: number, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!props.onReorder || event.button > 0) return
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>(':scope > li') ?? [])]
    const rects = rows.map((r) => r.getBoundingClientRect())
    const mine = rects[index]
    if (!mine) return
    event.preventDefault()
    const mids = rects.map((r) => r.top + r.height / 2)
    const startY = event.clientY
    const height = mine.height
    const target = event.currentTarget
    try {
      target.setPointerCapture(event.pointerId)
    } catch {
      // Synthetic events (tests) have no active pointer to capture.
    }
    let current: Drag = { from: index, to: index, offset: 0, height }
    setDrag(current)
    const move = (e: PointerEvent) => {
      const offset = e.clientY - startY
      const center = (mids[index] ?? 0) + offset
      current = { from: index, to: dropIndex(mids, index, center), offset, height }
      setDrag(current)
    }
    const end = (e: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      setDrag(null)
      if (e.type === 'pointerup' && current.to !== current.from) {
        props.onReorder?.(current.from, current.to)
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  const shiftOf = (i: number): number => {
    if (!drag) return 0
    if (i === drag.from) return drag.offset
    if (drag.to > drag.from && i > drag.from && i <= drag.to) return -drag.height
    if (drag.to < drag.from && i >= drag.to && i < drag.from) return drag.height
    return 0
  }

  return (
    <ul
      ref={listRef}
      aria-label={props.label}
      data-testid="task-list"
      className="divide-y divide-ash/60 rounded-xl border border-ash bg-paper-raised/50"
    >
      {props.tasks.map((task, i) => {
        const key = taskKey(task)
        return (
          <TaskRow
            key={key}
            task={task}
            today={props.today}
            now={props.now}
            selected={props.selectedKey === key}
            leaving={props.leaving.has(key)}
            showProject={props.showProject}
            people={props.people}
            onToggle={() => props.onToggle(task)}
            onOpen={() => props.onOpen(task)}
            onSelect={() => props.onSelect(task)}
            onDragStart={props.onReorder ? (event) => startDrag(i, event) : undefined}
            dragging={drag?.from === i}
            offsetY={shiftOf(i)}
          />
        )
      })}
    </ul>
  )
}
