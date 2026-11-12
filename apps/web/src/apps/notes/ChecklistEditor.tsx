import type { ChecklistItem } from '@hearth/format'
import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'

interface Row extends ChecklistItem {
  key: number
}

let nextKey = 1
const withKeys = (items: readonly ChecklistItem[]): Row[] =>
  items.map((i) => ({ ...i, key: nextKey++ }))

/**
 * A checklist: open items, then the ticked ones under a fold. Enter adds an item below, Backspace
 * in an empty item removes it. `onMakeTask` adds a "make a task" button on each open item.
 */
export function ChecklistEditor({
  items,
  onChange,
  onMakeTask,
  autoFocus = false,
}: {
  items: readonly ChecklistItem[]
  onChange: (items: ChecklistItem[]) => void
  onMakeTask?: ((text: string) => void) | undefined
  autoFocus?: boolean
}) {
  const [rows, setRows] = useState<Row[]>(() => withKeys(items))
  const [showTicked, setShowTicked] = useState(true)
  const inputs = useRef(new Map<number, HTMLInputElement>())
  const focusKey = useRef<number | null>(null)
  const newItem = useRef<HTMLInputElement>(null)

  // Items changed from outside (a reload): take them, keeping keys where the text matches.
  const last = useRef(items)
  useEffect(() => {
    if (items === last.current) return
    last.current = items
    setRows((prev) => {
      const same =
        prev.length === items.length &&
        prev.every((r, i) => r.text === items[i]?.text && r.checked === items[i]?.checked)
      return same ? prev : withKeys(items)
    })
  }, [items])

  useEffect(() => {
    if (focusKey.current === null) return
    const el = inputs.current.get(focusKey.current)
    focusKey.current = null
    el?.focus()
  })

  const commit = (next: Row[]) => {
    setRows(next)
    const plain = next.map(({ text, checked }) => ({ text, checked }))
    last.current = plain
    onChange(plain)
  }

  const update = (key: number, change: Partial<ChecklistItem>) =>
    commit(rows.map((r) => (r.key === key ? { ...r, ...change } : r)))

  const insertAfter = (key: number) => {
    const at = rows.findIndex((r) => r.key === key)
    const row: Row = { text: '', checked: false, key: nextKey++ }
    focusKey.current = row.key
    commit([...rows.slice(0, at + 1), row, ...rows.slice(at + 1)])
  }

  const remove = (key: number, focusPrevious: boolean) => {
    const open = rows.filter((r) => !r.checked)
    const at = open.findIndex((r) => r.key === key)
    if (focusPrevious) {
      const prev = open[at - 1]
      if (prev) focusKey.current = prev.key
      else newItem.current?.focus()
    }
    commit(rows.filter((r) => r.key !== key))
  }

  const open = rows.filter((r) => !r.checked)
  const ticked = rows.filter((r) => r.checked)

  const row = (r: Row) => (
    <li key={r.key} data-testid="checklist-item" className="group flex items-center gap-2 py-0.5">
      <input
        type="checkbox"
        checked={r.checked}
        aria-label={r.checked ? `Untick ${r.text}` : `Tick ${r.text}`}
        onChange={(e) => update(r.key, { checked: e.target.checked })}
        className="size-4 shrink-0 accent-[var(--ember)]"
      />
      <input
        ref={(el) => {
          if (el) inputs.current.set(r.key, el)
          else inputs.current.delete(r.key)
        }}
        value={r.text}
        aria-label="List item"
        onChange={(e) => update(r.key, { text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            insertAfter(r.key)
          } else if (e.key === 'Backspace' && r.text === '') {
            e.preventDefault()
            remove(r.key, true)
          }
        }}
        className={`min-w-0 flex-1 bg-transparent py-1 text-[0.95rem] outline-none ${r.checked ? 'text-ink-faint line-through' : 'text-ink'}`}
      />
      {onMakeTask && !r.checked && r.text.trim() ? (
        <button
          type="button"
          title="Make a task"
          aria-label={`Make a task: ${r.text}`}
          data-testid="checklist-make-task"
          onClick={() => onMakeTask(r.text.trim())}
          className="rounded p-1 text-ink-faint opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-ember [@media(hover:none)]:opacity-100"
        >
          <Icon name="tasks" className="size-3.5" />
        </button>
      ) : null}
      <button
        type="button"
        aria-label={`Remove ${r.text || 'item'}`}
        onClick={() => remove(r.key, false)}
        className="rounded p-1 text-ink-faint opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-ink [@media(hover:none)]:opacity-100"
      >
        <Icon name="close" className="size-3.5" />
      </button>
    </li>
  )

  return (
    <div data-testid="checklist-editor">
      <ul>{open.map(row)}</ul>
      <div className="flex items-center gap-2 py-0.5">
        <Icon name="plus" className="size-4 shrink-0 text-ink-faint" />
        <input
          ref={newItem}
          // biome-ignore lint/a11y/noAutofocus: the composer opens straight into its first item
          autoFocus={autoFocus}
          placeholder="List item"
          aria-label="New list item"
          data-testid="checklist-new"
          onChange={(e) => {
            const text = e.target.value
            if (!text) return
            e.target.value = ''
            const r: Row = { text, checked: false, key: nextKey++ }
            focusKey.current = r.key
            commit([...rows, r])
          }}
          className="min-w-0 flex-1 bg-transparent py-1 text-[0.95rem] text-ink outline-none placeholder:text-ink-faint"
        />
      </div>
      {ticked.length > 0 ? (
        <div className="mt-1 border-t border-ink/10 pt-1">
          <button
            type="button"
            onClick={() => setShowTicked((s) => !s)}
            aria-expanded={showTicked}
            className="flex items-center gap-1 py-1 text-xs text-ink-faint hover:text-ink"
          >
            <Icon name="chevron" className={`size-3 ${showTicked ? 'rotate-90' : ''}`} />
            {ticked.length} ticked item{ticked.length === 1 ? '' : 's'}
          </button>
          {showTicked ? <ul>{ticked.map(row)}</ul> : null}
        </div>
      ) : null}
    </div>
  )
}
