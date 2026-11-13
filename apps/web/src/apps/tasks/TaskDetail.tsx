import { normalizeRecurrence } from '@hearth/format'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router'
import type { Priority, TaskPatch, TaskPerson, TaskView } from '../../api/tasks'
import { AttachmentChips, FilePicker } from '../../components/FilePicker'
import { Icon } from '../../components/Icon'
import { meetingUrl } from '../../lib/paths'
import { dueWords } from './logic'

export interface TaskDetailProps {
  task: TaskView
  today: string
  tz: string
  me: string | undefined
  people: readonly TaskPerson[]
  /** Project names in the task's space, for the project combobox. */
  projectNames: string[]
  spaces: { personal: string | null; team: string | null }
  compact: boolean
  /** Bumped to put the cursor in the title (the `e` shortcut); 0 unless meant for this task. */
  focusTitle: number
  onPatch: (patch: TaskPatch) => void
  onToggle: () => void
  onMove: (toSpace: string) => void
  onDelete: () => void
  onClose: () => void
}

const PRIORITY_LABEL: Record<Priority, string> = {
  1: 'P1',
  2: 'P2',
  3: 'P3',
  4: 'None',
}

const field = 'text-[0.72rem] font-semibold tracking-wide text-ink-faint uppercase'
const control =
  'h-9 w-full rounded-lg border border-ash bg-paper-raised px-2.5 text-sm text-ink placeholder:text-ink-faint hover:border-ash-strong focus:border-ember focus:outline-none disabled:opacity-60'

function Row({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1">
      {htmlFor ? (
        <label htmlFor={htmlFor} className={field}>
          {label}
        </label>
      ) : (
        <span className={field}>{label}</span>
      )}
      {children}
    </div>
  )
}

/**
 * The task's detail (ARCHITECTURE §12.5): every field saves on change by PATCH; text fields
 * (title, notes, repeat, project) on blur. A side panel on wide screens, a bottom sheet on
 * phones.
 */
export function TaskDetail(props: TaskDetailProps) {
  const { task } = props
  const id = useId()
  const titleRef = useRef<HTMLInputElement>(null)
  // Escape blurs the title to leave it; that blur must not save what was typed.
  const discardTitle = useRef(false)
  const [title, setTitle] = useState(task.title)
  const [notes, setNotes] = useState(task.notes)
  const [picking, setPicking] = useState(false)
  const [recur, setRecur] = useState(task.recur ?? '')
  const [recurError, setRecurError] = useState<string | null>(null)
  const [project, setProject] = useState(task.project ?? '')
  const [label, setLabel] = useState('')

  // Adopt the server's values when another edit (or a teammate) changes them, unless the member
  // is typing in that field right now.
  const key = `${task.space}/${task.id}`
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-sync on the task's identity or content.
  useEffect(() => {
    const active = document.activeElement
    const editing = (el: string) => active instanceof HTMLElement && active.dataset.field === el
    if (!editing('title')) setTitle(task.title)
    if (!editing('notes')) setNotes(task.notes)
    if (!editing('recur')) {
      setRecur(task.recur ?? '')
      setRecurError(null)
    }
    if (!editing('project')) setProject(task.project ?? '')
  }, [key, task.title, task.notes, task.recur, task.project])

  useEffect(() => {
    if (props.focusTitle > 0) {
      titleRef.current?.focus()
      titleRef.current?.select()
    }
  }, [props.focusTitle])

  const saveTitle = () => {
    if (discardTitle.current) {
      discardTitle.current = false
      return
    }
    const next = title.replace(/\s+/g, ' ').trim()
    if (!next) {
      setTitle(task.title)
      return
    }
    if (next !== task.title) props.onPatch({ title: next, baseBlobOid: task.blobOid })
  }
  const saveNotes = () => {
    if (notes !== task.notes) props.onPatch({ notes, baseBlobOid: task.blobOid })
  }
  const saveRecur = () => {
    const text = recur.trim()
    if (!text) {
      setRecurError(null)
      if (task.recur) props.onPatch({ recur: null })
      return
    }
    const rule = normalizeRecurrence(text)
    if (!rule) {
      setRecurError('Try “every week”, “every monday, thursday” or “every 2 days”.')
      return
    }
    setRecurError(null)
    setRecur(rule)
    if (rule !== task.recur) props.onPatch({ recur: rule })
  }
  const saveProject = () => {
    const next = project.trim()
    if (next !== (task.project ?? '')) props.onPatch({ project: next || null })
  }

  const date = task.due ? task.due.slice(0, 10) : ''
  const time = task.due && task.due.length > 10 ? task.due.slice(11, 16) : ''
  const setDue = (nextDate: string, nextTime: string) => {
    if (!nextDate) {
      props.onPatch({ due: null })
      return
    }
    const due = nextTime ? `${nextDate}T${nextTime}` : nextDate
    props.onPatch(nextTime ? { due, tz: task.tz ?? props.tz } : { due })
  }

  const addLabel = () => {
    const next = label.trim().replace(/^@/, '').toLowerCase()
    setLabel('')
    if (next && !task.labels.includes(next)) props.onPatch({ labels: [...task.labels, next] })
  }

  const inPersonal = task.space === props.spaces.personal
  const others = props.people.filter((p) => p.email !== props.me)
  const source = task.source
  const done = task.status === 'done'

  const body = (
    <div data-testid="task-detail" data-key={key} className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-ash/70 px-4 py-3">
        {/* biome-ignore lint/a11y/useSemanticElements: a round, priority-colored checkbox. */}
        <button
          type="button"
          role="checkbox"
          aria-checked={done}
          aria-label={done ? 'Reopen' : 'Complete'}
          data-priority={task.priority}
          data-testid="detail-check"
          onClick={props.onToggle}
          className="task-check mt-0"
        >
          <Icon name="check" className="size-3" />
        </button>
        <input
          ref={titleRef}
          aria-label="Title"
          data-field="title"
          data-testid="detail-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') {
              discardTitle.current = true
              setTitle(task.title)
              e.currentTarget.blur()
            }
          }}
          className={`min-w-0 flex-1 rounded-md bg-transparent py-1.5 font-display text-[1.25rem] leading-snug font-semibold tracking-tight text-ink focus:outline-none ${done ? 'line-through decoration-ash-strong' : ''}`}
        />
        <button
          type="button"
          aria-label="Close"
          data-testid="detail-close"
          onClick={props.onClose}
          className="mt-1.5 flex size-8 shrink-0 items-center justify-center rounded-md text-ink-faint hover:bg-paper-sunk hover:text-ink"
        >
          <Icon name="close" className="size-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pt-4 pb-6">
        <textarea
          aria-label="Notes"
          data-field="notes"
          data-testid="detail-notes"
          value={notes}
          placeholder="Notes"
          rows={4}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={saveNotes}
          className="block w-full resize-y rounded-lg border border-ash bg-paper-raised px-3 py-2 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus:border-ember focus:outline-none"
        />
        <div className="-mt-2 flex flex-wrap items-center gap-2">
          <AttachmentChips text={notes} />
          <button
            type="button"
            data-testid="detail-attach"
            onClick={() => setPicking(true)}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-ink-soft hover:bg-paper-sunk hover:text-ink"
          >
            <Icon name="paperclip" className="size-3.5" />
            Attach a file
          </button>
        </div>
        {picking ? (
          <FilePicker
            targetSpace={task.space}
            onClose={() => setPicking(false)}
            onPick={(a) => {
              setPicking(false)
              const trimmed = notes.replace(/\s+$/, '')
              const next = trimmed ? `${trimmed}\n${a.markdown}` : a.markdown
              setNotes(next)
              props.onPatch({ notes: next, baseBlobOid: task.blobOid })
            }}
          />
        ) : null}

        <Row label="Due">
          <div className="grid grid-cols-[minmax(0,1fr)_7.5rem] gap-2">
            <input
              type="date"
              aria-label="Due date"
              data-testid="detail-date"
              value={date}
              onChange={(e) => setDue(e.target.value, time)}
              className={control}
            />
            <input
              type="time"
              aria-label="Due time"
              data-testid="detail-time"
              value={time}
              disabled={!date}
              onChange={(e) => setDue(date, e.target.value)}
              className={`${control} min-w-0`}
            />
          </div>
          {task.due ? (
            <p className="flex items-center justify-between text-xs text-ink-faint">
              <span>{dueWords(task.due, props.today)}</span>
              <button
                type="button"
                onClick={() => props.onPatch({ due: null })}
                className="text-ink-soft hover:text-ember-strong"
              >
                Clear
              </button>
            </p>
          ) : null}
        </Row>

        <Row label="Repeat" htmlFor={`${id}-recur`}>
          <input
            id={`${id}-recur`}
            data-field="recur"
            data-testid="detail-recur"
            value={recur}
            placeholder="every week"
            onChange={(e) => setRecur(e.target.value)}
            onBlur={saveRecur}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
            aria-invalid={recurError ? true : undefined}
            className={control}
          />
          <p className={`text-xs ${recurError ? 'text-ember-strong' : 'text-ink-faint'}`}>
            {recurError ?? 'every day, every weekday, every monday, every 2 weeks, every month'}
          </p>
        </Row>

        <Row label="Priority">
          <div role="radiogroup" aria-label="Priority" className="flex gap-1.5">
            {([1, 2, 3, 4] as const).map((p) => (
              // biome-ignore lint/a11y/useSemanticElements: a row of flag buttons.
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={task.priority === p}
                data-testid={`detail-priority-${p}`}
                onClick={() => p !== task.priority && props.onPatch({ priority: p })}
                className={`inline-flex h-8 flex-1 items-center justify-center gap-1 rounded-lg border text-sm ${
                  task.priority === p
                    ? 'border-ember bg-ember-wash text-ink'
                    : 'border-ash text-ink-soft hover:border-ash-strong'
                }`}
              >
                <span
                  className="size-2 rounded-full"
                  style={{ background: `var(--task-p${p})` }}
                  aria-hidden="true"
                />
                {PRIORITY_LABEL[p]}
              </button>
            ))}
          </div>
        </Row>

        <Row label="Project" htmlFor={`${id}-project`}>
          <input
            id={`${id}-project`}
            list={`${id}-projects`}
            data-field="project"
            data-testid="detail-project"
            value={project}
            placeholder="No project"
            onChange={(e) => setProject(e.target.value)}
            onBlur={saveProject}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
            className={control}
          />
          <datalist id={`${id}-projects`}>
            {props.projectNames.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </Row>

        <Row label="Labels" htmlFor={`${id}-label`}>
          <div className="flex flex-wrap items-center gap-1.5">
            {task.labels.map((l) => (
              <span key={l} className="task-chip" data-testid="detail-label">
                @{l}
                <button
                  type="button"
                  aria-label={`Remove label ${l}`}
                  onClick={() => props.onPatch({ labels: task.labels.filter((x) => x !== l) })}
                  className="text-ink-faint hover:text-ember-strong"
                >
                  <Icon name="close" className="size-2.5" />
                </button>
              </span>
            ))}
            <input
              id={`${id}-label`}
              data-testid="detail-label-input"
              value={label}
              placeholder="Add a label"
              onChange={(e) => setLabel(e.target.value)}
              onBlur={addLabel}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault()
                  addLabel()
                }
              }}
              className="h-7 min-w-24 flex-1 rounded-md bg-transparent px-1 text-sm text-ink placeholder:text-ink-faint focus:outline-none"
            />
          </div>
        </Row>

        <Row label="Assignee" htmlFor={`${id}-assignee`}>
          <select
            id={`${id}-assignee`}
            data-testid="detail-assignee"
            value={task.assignee ?? ''}
            onChange={(e) => props.onPatch({ assignee: e.target.value || null })}
            className={control}
          >
            <option value="">Unassigned</option>
            {props.me ? <option value={props.me}>Me</option> : null}
            {others.map((p) => (
              <option key={p.email} value={p.email} disabled={inPersonal}>
                {p.name}
              </option>
            ))}
          </select>
          {inPersonal ? (
            <p className="text-xs text-ink-faint">Move it to Team to assign it to someone else.</p>
          ) : null}
        </Row>

        {props.spaces.personal && props.spaces.team ? (
          <Row label="Space">
            <div role="radiogroup" aria-label="Space" className="clips-tabs self-start">
              {[
                { name: props.spaces.personal, label: 'Personal' },
                { name: props.spaces.team, label: 'Team' },
              ].map((s) => (
                // biome-ignore lint/a11y/useSemanticElements: a segmented control.
                <button
                  key={s.name}
                  type="button"
                  role="radio"
                  aria-checked={task.space === s.name}
                  data-testid={`detail-space-${s.label.toLowerCase()}`}
                  disabled={
                    s.name === props.spaces.personal &&
                    !!task.assignee &&
                    task.assignee !== props.me
                  }
                  onClick={() => task.space !== s.name && props.onMove(s.name as string)}
                  className="disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {s.label}
                </button>
              ))}
            </div>
          </Row>
        ) : null}

        {source && source.kind !== 'manual' ? (
          <Row label="From">
            {source.kind === 'meeting' && source.space && source.path ? (
              <Link
                data-testid="detail-source"
                to={`${meetingUrl(source.space, source.path)}${source.line ? `#L${source.line}` : ''}`}
                className="flex items-center gap-2 text-sm text-ink underline decoration-ash-strong underline-offset-2 hover:decoration-ember"
              >
                <Icon name="calendar" className="size-3.5 text-ink-faint" />
                {source.text ? `A meeting: “${source.text}”` : 'A meeting note'}
              </Link>
            ) : (
              <p data-testid="detail-source" className="text-sm text-ink-soft">
                {source.kind === 'voice'
                  ? 'Ramble (voice)'
                  : source.kind === 'import'
                    ? `Imported from ${source.from === 'todoist' ? 'Todoist' : (source.from ?? 'elsewhere')}`
                    : 'An agent (MCP)'}
              </p>
            )}
          </Row>
        ) : null}

        <p className="text-xs text-ink-faint">
          Added {new Date(task.created).toLocaleDateString(undefined, { dateStyle: 'medium' })}
          {task.createdBy !== props.me ? ` by ${task.createdBy}` : ''}
          {task.completed
            ? ` · Done ${new Date(task.completed).toLocaleDateString(undefined, { dateStyle: 'medium' })}`
            : ''}
        </p>

        <button
          type="button"
          data-testid="detail-delete"
          onClick={props.onDelete}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-ash px-3 text-sm text-ember-strong hover:border-ember"
        >
          <Icon name="trash" className="size-4" />
          Delete task
        </button>
      </div>
    </div>
  )

  if (props.compact) {
    // On the body: the shell's main column is its own stacking context, under the tab bar.
    return createPortal(
      <div className="fixed inset-0 z-50 flex flex-col justify-end">
        <button
          type="button"
          aria-label="Close task"
          tabIndex={-1}
          onClick={props.onClose}
          className="flex-1 cursor-default bg-paper-sunk/60 backdrop-blur-[1px]"
        />
        <section
          aria-label="Task"
          className="task-sheet flex max-h-[85dvh] min-h-[50dvh] flex-col rounded-t-2xl border-t border-ash bg-paper pb-[env(safe-area-inset-bottom)] shadow-float"
        >
          <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-ash-strong/70" aria-hidden="true" />
          {body}
        </section>
      </div>,
      document.body,
    )
  }

  return (
    <aside
      aria-label="Task"
      className="side-pane flex h-full w-[var(--panel-width)] shrink-0 flex-col border-l border-ash bg-paper/70"
    >
      {body}
    </aside>
  )
}
