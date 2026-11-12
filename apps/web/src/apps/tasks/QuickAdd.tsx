import { type ParsedTask, parseQuickAdd } from '@hearth/format'
import { type KeyboardEvent, type ReactNode, useMemo, useRef, useState } from 'react'
import { type TaskPerson, type TaskView, tasksApi } from '../../api/tasks'
import { Icon, type IconName } from '../../components/Icon'
import { type Chip, chipsFor, resolvePerson } from './logic'
import { Ramble } from './Ramble'
import { errorMessage } from './useTaskList'

export type SpaceChoice = 'personal' | 'team'

/** Parses a quick-add line the way the server will, for today in the member's zone. */
export function useParsed(text: string, today: string): ParsedTask {
  return useMemo(() => parseQuickAdd(text, { today }), [text, today])
}

/**
 * Whether a line assigns someone other than the member, which only a team task can. Before the
 * people list loads (empty), only the member's own handle is known; any other is left to the
 * server to resolve rather than forcing Team.
 */
export function assignsSomeoneElse(
  parsed: ParsedTask,
  people: readonly TaskPerson[],
  me: string | undefined,
): boolean {
  if (!parsed.assignee) return false
  const name = parsed.assignee.toLowerCase()
  const own = me?.toLowerCase()
  if (own && (name === own || name === own.split('@')[0])) return false
  const person = resolvePerson(people, parsed.assignee)
  if (!person && people.length === 0) return false
  const email = person?.email ?? parsed.assignee
  return !own || email.toLowerCase() !== own
}

/**
 * A one-line input whose recognized tokens are highlighted as the member types: a backdrop
 * behind the (transparent) input holds the same text, with each token in a <mark>.
 */
export function QuickField({
  value,
  onChange,
  parsed,
  onKeyDown,
  placeholder,
  label,
  autoFocus = false,
  testId,
}: {
  value: string
  onChange: (value: string) => void
  parsed: ParsedTask
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void
  placeholder?: string
  label: string
  autoFocus?: boolean
  testId?: string
}) {
  const backdrop = useRef<HTMLDivElement>(null)
  const pieces: ReactNode[] = []
  let at = 0
  for (const token of parsed.tokens) {
    if (token.from < at) continue
    pieces.push(value.slice(at, token.from))
    pieces.push(
      <mark key={`${token.from}-${token.kind}`} data-kind={token.kind}>
        {value.slice(token.from, token.to)}
      </mark>,
    )
    at = token.to
  }
  pieces.push(value.slice(at))
  return (
    <div className="quick-field">
      <div ref={backdrop} className="quick-backdrop" aria-hidden="true" data-testid="quick-marks">
        {pieces}
      </div>
      <input
        aria-label={label}
        data-testid={testId}
        value={value}
        // biome-ignore lint/a11y/noAutofocus: the field opens because the member asked to type.
        autoFocus={autoFocus}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onScroll={(e) => {
          if (backdrop.current) backdrop.current.scrollLeft = e.currentTarget.scrollLeft
        }}
        onSelect={(e) => {
          if (backdrop.current) backdrop.current.scrollLeft = e.currentTarget.scrollLeft
        }}
      />
    </div>
  )
}

const CHIP_ICON: Record<Chip['kind'], IconName | null> = {
  date: 'calendar',
  recur: 'repeat',
  priority: 'flag',
  project: 'hash',
  label: null,
  assignee: null,
}

export function ChipRow({ chips }: { chips: Chip[] }) {
  if (chips.length === 0) return null
  return (
    <ul aria-label="What this sets" data-testid="quick-chips" className="flex flex-wrap gap-1.5">
      {chips.map((chip) => (
        <li
          key={`${chip.kind}:${chip.label}`}
          data-testid="quick-chip"
          data-kind={chip.kind}
          className="task-chip"
        >
          {CHIP_ICON[chip.kind] ? (
            <Icon name={CHIP_ICON[chip.kind] as IconName} className="size-3" />
          ) : null}
          {chip.label}
        </li>
      ))}
    </ul>
  )
}

/** Personal or Team; Team is the only choice while the line assigns someone else. */
export function SpaceSwitch({
  value,
  onChange,
  forcedTeam,
}: {
  value: SpaceChoice
  onChange: (value: SpaceChoice) => void
  forcedTeam: boolean
}) {
  const shown = forcedTeam ? 'team' : value
  return (
    <div
      role="radiogroup"
      aria-label="Where it goes"
      className="clips-tabs"
      data-testid="space-switch"
    >
      {(['personal', 'team'] as const).map((choice) => (
        // biome-ignore lint/a11y/useSemanticElements: a segmented control, styled like Clips' tabs.
        <button
          key={choice}
          type="button"
          role="radio"
          aria-checked={shown === choice}
          data-testid={`space-${choice}`}
          disabled={forcedTeam && choice === 'personal'}
          title={
            forcedTeam && choice === 'personal'
              ? 'A task for someone else goes in the team space'
              : undefined
          }
          onClick={() => onChange(choice)}
          className="disabled:cursor-not-allowed disabled:opacity-50"
        >
          {choice === 'personal' ? 'Personal' : 'Team'}
        </button>
      ))}
    </div>
  )
}

export interface QuickAddProps {
  today: string
  tz: string
  me: string | undefined
  people: readonly TaskPerson[]
  /** Space names: the member's personal space and the team's. */
  spaces: { personal: string | null; team: string | null }
  defaultSpace: SpaceChoice
  /** The project of the list it opened in, used when the line names none. */
  defaultProject?: string | undefined
  /** Today's list adds tasks due today unless the line says when. */
  dueTodayByDefault?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded: (task: TaskView) => void
  onError: (message: string) => void
}

/** The line text the server gets: the member's words, plus "today" in Today's list. */
export function quickText(text: string, parsed: ParsedTask, dueTodayByDefault: boolean): string {
  return dueTodayByDefault && !parsed.due ? `${text.trim()} today` : text.trim()
}

/**
 * Quick add (ARCHITECTURE §12.5): one line, tokens highlighted live, chips for what they set,
 * Personal / Team, Enter adds and closes, Shift+Enter adds and stays open, Esc closes; Ramble
 * records a spoken list instead.
 */
export function QuickAdd(props: QuickAddProps) {
  const [text, setText] = useState('')
  const [choice, setChoice] = useState<SpaceChoice>(props.defaultSpace)
  const [busy, setBusy] = useState(false)
  const [rambling, setRambling] = useState(false)
  const parsed = useParsed(text, props.today)
  const forcedTeam = assignsSomeoneElse(parsed, props.people, props.me)
  const space = forcedTeam || choice === 'team' ? props.spaces.team : props.spaces.personal
  const chips = chipsFor(parsed, props.today)
  if (props.defaultProject && !parsed.project) {
    chips.push({ kind: 'project', label: `#${props.defaultProject}` })
  }
  if (props.dueTodayByDefault && !parsed.due) {
    chips.unshift({ kind: 'date', label: 'Today' })
  }

  const submit = async (keepOpen: boolean) => {
    if (!parsed.title.trim() || busy) return
    setBusy(true)
    try {
      const body: Parameters<typeof tasksApi.quick>[0] = {
        text: quickText(text, parsed, props.dueTodayByDefault ?? false),
        tz: props.tz,
      }
      if (space) body.space = space
      if (props.defaultProject && !parsed.project) body.project = props.defaultProject
      const task = await tasksApi.quick(body)
      props.onAdded(task)
      setText('')
      if (!keepOpen) props.onOpenChange(false)
    } catch (err) {
      props.onError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  if (!props.open) {
    return (
      <button
        type="button"
        data-testid="quick-add-open"
        onClick={() => props.onOpenChange(true)}
        className="group flex h-11 w-full items-center gap-2.5 rounded-xl px-3 text-left text-[0.95rem] text-ink-soft hover:text-ember-strong"
      >
        <span className="flex size-5 items-center justify-center rounded-full text-ember group-hover:bg-ember group-hover:text-paper-raised">
          <Icon name="plus" className="size-3.5" />
        </span>
        Add task
      </button>
    )
  }

  if (rambling) {
    return (
      <Ramble
        today={props.today}
        tz={props.tz}
        me={props.me}
        people={props.people}
        spaces={props.spaces}
        defaultSpace={choice}
        onClose={() => setRambling(false)}
        onAdded={props.onAdded}
        onError={props.onError}
      />
    )
  }

  return (
    <form
      data-testid="quick-add"
      onSubmit={(e) => {
        e.preventDefault()
        void submit(false)
      }}
      className="rounded-xl border border-ash bg-paper-raised px-3.5 pt-1.5 pb-3 shadow-float"
    >
      <QuickField
        value={text}
        onChange={setText}
        parsed={parsed}
        autoFocus
        label="Task"
        testId="quick-add-input"
        placeholder="Call Sam fri 3pm p1 #Ops @calls"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            props.onOpenChange(false)
          } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void submit(e.shiftKey)
          }
        }}
      />
      <div className="min-h-[1.5rem]">
        <ChipRow chips={chips} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-ash/70 pt-3">
        <SpaceSwitch value={choice} onChange={setChoice} forcedTeam={forcedTeam} />
        <button
          type="button"
          data-testid="ramble-open"
          onClick={() => setRambling(true)}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-ash px-2.5 text-sm text-ink-soft hover:border-ember hover:text-ink"
        >
          <Icon name="mic" className="size-3.5" />
          Ramble
        </button>
        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => props.onOpenChange(false)}
            className="inline-flex h-8 items-center rounded-lg px-3 text-sm text-ink-soft hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="submit"
            data-testid="quick-add-submit"
            disabled={!parsed.title.trim() || busy}
            className="inline-flex h-8 items-center rounded-lg bg-ember px-3.5 text-sm font-medium text-paper-raised hover:bg-ember-strong disabled:cursor-not-allowed disabled:opacity-50"
          >
            Add task
          </button>
        </span>
      </div>
      <p className="mt-2 hidden text-[0.72rem] text-ink-faint sm:block">
        Enter adds · Shift+Enter adds another · Esc closes
      </p>
    </form>
  )
}
