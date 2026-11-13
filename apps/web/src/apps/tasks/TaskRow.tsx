import type { PointerEvent as ReactPointerEvent } from 'react'
import type { TaskPerson, TaskView } from '../../api/tasks'
import { Icon } from '../../components/Icon'
import { dueWords, isOverdue, personInitials } from './logic'

export interface TaskRowProps {
  task: TaskView
  today: string
  now: Date
  selected: boolean
  leaving: boolean
  /** The project chip repeats the list's name in a project view; leave it out there. */
  showProject: boolean
  people: readonly TaskPerson[]
  onToggle: () => void
  onOpen: () => void
  onSelect: () => void
  /** Present in lists the member orders by hand. */
  onDragStart?: ((event: ReactPointerEvent<HTMLButtonElement>) => void) | undefined
  dragging?: boolean
  /** How far the row is moved while a drag is on: the dragged row follows the pointer, the
   * rows it passes make room. */
  offsetY?: number
}

/** One task: the round checkbox (colored by priority), the title and first line of notes, chips. */
export function TaskRow({
  task,
  today,
  now,
  selected,
  leaving,
  showProject,
  people,
  onToggle,
  onOpen,
  onSelect,
  onDragStart,
  dragging = false,
  offsetY = 0,
}: TaskRowProps) {
  const done = task.status === 'done'
  const overdue = isOverdue(task, today, now)
  const firstLine = task.notes
    .split('\n')
    .find((l) => l.trim())
    ?.trim()
  const assignee = task.assignee ? people.find((p) => p.email === task.assignee) : undefined
  return (
    <li
      data-testid="task-row"
      data-key={`${task.space}/${task.id}`}
      data-id={task.id}
      data-selected={selected ? 'true' : undefined}
      data-leaving={leaving ? 'true' : undefined}
      data-dragging={dragging ? 'true' : undefined}
      style={offsetY ? { transform: `translateY(${offsetY}px)` } : undefined}
      onPointerDown={onSelect}
      className="task-row group flex items-start gap-2 px-2 py-2.5 sm:px-3"
    >
      {onDragStart ? (
        <button
          type="button"
          aria-label={`Drag to reorder: ${task.title}`}
          data-testid="task-handle"
          onPointerDown={(event) => {
            event.stopPropagation()
            onSelect()
            onDragStart(event)
          }}
          className="task-handle tap-target -ml-1 flex h-5 w-4 shrink-0 cursor-grab items-center justify-center text-ink-faint active:cursor-grabbing"
        >
          <Icon name="grip" className="size-3.5" />
        </button>
      ) : (
        <span className="hidden w-3 shrink-0 sm:block" aria-hidden="true" />
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: a round, priority-colored checkbox. */}
      <button
        type="button"
        role="checkbox"
        aria-checked={done || leaving}
        aria-label={`${done ? 'Reopen' : 'Complete'}: ${task.title}`}
        data-testid="task-check"
        data-priority={task.priority}
        onClick={(event) => {
          event.stopPropagation()
          onToggle()
        }}
        className="task-check"
      >
        <Icon name="check" className="size-3" />
      </button>
      <button
        type="button"
        onClick={onOpen}
        data-testid="task-open"
        className="min-w-0 flex-1 rounded-md text-left focus-visible:shadow-none"
      >
        <span
          data-testid="task-title"
          className={`block text-[0.95rem] leading-snug ${done ? 'text-ink-faint line-through decoration-ash-strong' : 'text-ink'}`}
        >
          {task.title}
        </span>
        {firstLine ? (
          <span className="mt-0.5 block truncate text-[0.82rem] text-ink-faint">{firstLine}</span>
        ) : null}
        <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.78rem] empty:hidden">
          {task.due ? (
            <span
              data-testid="task-due"
              data-overdue={overdue ? 'true' : undefined}
              className={`inline-flex items-center gap-1 ${overdue ? 'text-ember-strong' : done ? 'text-ink-faint' : 'text-moss'}`}
            >
              <Icon name="calendar" className="size-3" />
              {dueWords(task.due, today)}
              {task.recur ? (
                <span title={task.recur} className="inline-flex">
                  <Icon name="repeat" className="size-3" />
                  <span className="sr-only">Repeats {task.recur}</span>
                </span>
              ) : null}
            </span>
          ) : null}
          {showProject && task.project ? (
            <span className="inline-flex items-center gap-0.5 text-ink-faint">
              <Icon name="hash" className="size-3" />
              {task.project}
            </span>
          ) : null}
          {task.labels.map((label) => (
            <span key={label} className="text-ink-faint">
              @{label}
            </span>
          ))}
          {task.source?.kind === 'meeting' ? (
            <span className="inline-flex items-center gap-1 text-ink-faint">
              <Icon name="calendar" className="size-3" />
              From a meeting
            </span>
          ) : null}
        </span>
      </button>
      {task.assignee ? (
        <span
          title={assignee?.name ?? task.assignee}
          data-testid="task-assignee"
          className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-ash bg-paper-sunk text-[0.62rem] font-semibold text-ink-soft"
        >
          {personInitials(task.assignee, assignee?.name)}
        </span>
      ) : null}
    </li>
  )
}
