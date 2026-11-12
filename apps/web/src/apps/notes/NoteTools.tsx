import type { NoteColor } from '@hearth/format'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from '../../components/Icon'
import { COLOR_NAMES, COLORS } from './logic'

export function ToolButton({
  icon,
  label,
  onClick,
  active = false,
  testId,
}: {
  icon: IconName
  label: string
  onClick: () => void
  active?: boolean
  testId?: string | undefined
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      data-testid={testId}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={`inline-flex size-8 items-center justify-center rounded-full hover:bg-ink/10 ${active ? 'text-ink' : 'text-ink-soft hover:text-ink'}`}
    >
      <Icon name={icon} className="size-4" />
    </button>
  )
}

/** A popover anchored to its button; closes on Escape or a click outside. */
function Popover({
  icon,
  label,
  testId,
  below = false,
  children,
}: {
  icon: IconName
  label: string
  testId?: string | undefined
  below?: boolean | undefined
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: stops clicks reaching the card behind
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard use goes to the buttons inside
    <div ref={root} className="relative" onClick={(e) => e.stopPropagation()}>
      <ToolButton icon={icon} label={label} testId={testId} onClick={() => setOpen((o) => !o)} />
      {open ? (
        <div
          className={`absolute left-0 z-30 rounded-xl ${below ? 'top-full mt-1' : 'bottom-full mb-1'} border border-ash bg-paper-raised p-2 shadow-float`}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  )
}

export function ColorPicker({
  value,
  onChange,
  below,
}: {
  value: NoteColor | null
  onChange: (color: NoteColor | null) => void
  below?: boolean
}) {
  return (
    <Popover icon="palette" label="Background color" testId="note-color" below={below}>
      {(close) => (
        <div className="grid w-max grid-cols-6 gap-1.5">
          {COLORS.map((c) => (
            <button
              key={c ?? 'default'}
              type="button"
              aria-pressed={value === c}
              aria-label={c ? COLOR_NAMES[c] : 'Default'}
              title={c ? COLOR_NAMES[c] : 'Default'}
              data-testid={`note-color-${c ?? 'default'}`}
              onClick={() => {
                onChange(c)
                close()
              }}
              {...(c ? { 'data-color': c } : {})}
              className={`note-surface size-7 rounded-full border-2 ${value === c ? 'outline-2 outline-offset-1 outline-ember' : ''}`}
            />
          ))}
        </div>
      )}
    </Popover>
  )
}

export function LabelPicker({
  value,
  suggestions,
  onChange,
  below,
}: {
  value: readonly string[]
  suggestions: readonly string[]
  onChange: (labels: string[]) => void
  below?: boolean
}) {
  const [text, setText] = useState('')
  const has = (l: string) => value.some((v) => v.toLowerCase() === l.toLowerCase())
  const add = (l: string) => {
    const label = l.replace(/\s+/g, ' ').trim()
    if (label && !has(label)) onChange([...value, label])
    setText('')
  }
  const matches = suggestions
    .filter((s) => !has(s) && s.toLowerCase().includes(text.trim().toLowerCase()))
    .slice(0, 8)
  return (
    <Popover icon="tag" label="Labels" testId="note-labels" below={below}>
      {() => (
        <div className="w-56">
          <input
            // biome-ignore lint/a11y/noAutofocus: the popover is for typing a label
            autoFocus
            value={text}
            placeholder="Add a label"
            aria-label="Add a label"
            data-testid="note-label-input"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                add(text)
              }
            }}
            className="h-8 w-full rounded-md border border-ash bg-paper px-2 text-sm text-ink outline-none focus:border-ember"
          />
          {value.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-1">
              {value.map((l) => (
                <li key={l}>
                  <button
                    type="button"
                    onClick={() => onChange(value.filter((v) => v !== l))}
                    aria-label={`Remove label ${l}`}
                    className="inline-flex items-center gap-1 rounded-full bg-ink/10 px-2 py-0.5 text-xs text-ink"
                  >
                    {l}
                    <Icon name="close" className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {matches.length > 0 ? (
            <ul className="mt-2 max-h-40 overflow-y-auto border-t border-ash pt-1">
              {matches.map((s) => (
                <li key={s}>
                  <button
                    type="button"
                    onClick={() => add(s)}
                    className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm text-ink-soft hover:bg-paper hover:text-ink"
                  >
                    <Icon name="tag" className="size-3.5" />
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </Popover>
  )
}
