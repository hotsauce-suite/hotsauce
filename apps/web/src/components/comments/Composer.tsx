import { findMentions, MAX_COMMENT } from '@hotsauce/format'
import { type KeyboardEvent, type Ref, useId, useMemo, useRef, useState } from 'react'
import type { CommentMember } from '../../api/comments'

/** The `@` being typed at the caret: where it starts and what follows it, or null. */
export function mentionQuery(text: string, caret: number): { from: number; query: string } | null {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at === -1) return null
  if (at > 0 && !/\s|[([{"'“‘]/.test(before[at - 1] ?? '')) return null
  const query = before.slice(at + 1)
  // Two words reach a full name; past that, or onto a new line, it is no longer a mention.
  if (query.length > 40 || /\n/.test(query) || query.split(/\s+/).length > 3) return null
  return { from: at, query }
}

/**
 * What to write for a member: their name, else their handle, else the start of their email;
 * the first that the server will read as them and nobody else (a name, a handle or an email
 * start that two members share names neither).
 */
export function mentionText(member: CommentMember, members: readonly CommentMember[]): string {
  const options = [member.name.trim(), member.handle, member.email.split('@')[0] ?? '']
  for (const option of options) {
    if (!option) continue
    const text = `@${option}`
    const found = findMentions(text, members)
    if (found.length === 1 && found[0]?.to === text.length && found[0].email === member.email) {
      return text
    }
  }
  return `@${member.name.trim() || member.handle}`
}

function matching(members: readonly CommentMember[], query: string): CommentMember[] {
  const q = query.trim().toLowerCase()
  // Past a finished name ("@Sam Okafor "), the mention is written: nothing more to offer.
  if (
    /\s$/.test(query) &&
    !members.some((m) => m.name.toLowerCase().startsWith(query.toLowerCase()))
  ) {
    return []
  }
  const scored = members
    .map((m) => {
      const name = m.name.toLowerCase()
      const keys = [name, m.handle.toLowerCase(), m.email.toLowerCase()]
      if (!q) return { m, score: 1 }
      if (keys.some((k) => k.startsWith(q))) return { m, score: 0 }
      if (name.split(/\s+/).some((w) => w.startsWith(q))) return { m, score: 1 }
      return keys.some((k) => k.includes(q)) ? { m, score: 2 } : null
    })
    .filter((x): x is { m: CommentMember; score: number } => x !== null)
  scored.sort((a, b) => a.score - b.score || a.m.name.localeCompare(b.m.name))
  return scored.slice(0, 6).map((x) => x.m)
}

export interface ComposerProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel?: () => void
  members: readonly CommentMember[]
  /** Holds the text as it is (while it is being sent) without dropping the cursor. */
  readOnly?: boolean
  placeholder?: string
  label: string
  testId: string
  rows?: number
  autoFocus?: boolean
  inputRef?: Ref<HTMLTextAreaElement>
}

/**
 * The comment box: plain text, `@` opens the people to mention, Command-Enter sends. A new line
 * is just Enter, so a comment can have paragraphs.
 */
export function Composer(props: ComposerProps) {
  const { value, members } = props
  const listId = useId()
  const own = useRef<HTMLTextAreaElement | null>(null)
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState<number | null>(null)

  const open = useMemo(() => mentionQuery(value, caret), [value, caret])
  const options = useMemo(
    () => (open && open.from !== dismissed ? matching(members, open.query) : []),
    [open, dismissed, members],
  )
  const index = Math.min(active, Math.max(0, options.length - 1))

  const setRef = (el: HTMLTextAreaElement | null) => {
    own.current = el
    const { inputRef } = props
    if (typeof inputRef === 'function') inputRef(el)
    else if (inputRef) inputRef.current = el
  }

  const pick = (member: CommentMember) => {
    if (!open) return
    const insert = `${mentionText(member, members)} `
    const next = value.slice(0, open.from) + insert + value.slice(caret)
    const at = open.from + insert.length
    props.onChange(next)
    setCaret(at)
    requestAnimationFrame(() => {
      own.current?.focus()
      own.current?.setSelectionRange(at, at)
    })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter while composing (Japanese, Chinese, Korean input) chooses a character, nothing else.
    if (event.nativeEvent.isComposing) return
    if (options.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        setActive((index + step + options.length) % options.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const member = options[index]
        if (member) pick(member)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setDismissed(open?.from ?? null)
        return
      }
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      props.onSubmit()
      return
    }
    if (event.key === 'Escape' && props.onCancel) {
      event.preventDefault()
      event.stopPropagation()
      props.onCancel()
    }
  }

  return (
    <div className="relative">
      <textarea
        ref={setRef}
        value={value}
        rows={props.rows ?? 2}
        maxLength={MAX_COMMENT}
        readOnly={props.readOnly}
        placeholder={props.placeholder}
        aria-label={props.label}
        aria-autocomplete="list"
        aria-controls={options.length > 0 ? listId : undefined}
        aria-expanded={options.length > 0}
        aria-activedescendant={options.length > 0 ? `${listId}-${index}` : undefined}
        role="combobox"
        data-testid={props.testId}
        // biome-ignore lint/a11y/noAutofocus: the member just pressed Edit
        autoFocus={props.autoFocus}
        onChange={(e) => {
          props.onChange(e.target.value)
          setCaret(e.target.selectionStart)
          setActive(0)
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        className="block w-full resize-y rounded-lg border border-ash-strong bg-paper-raised px-3 py-2 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus:border-ember focus:outline-none read-only:opacity-70"
      />
      {options.length > 0 ? (
        <ul
          id={listId}
          // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the picker's list
          role="listbox"
          aria-label="People to mention"
          data-testid="mention-picker"
          // Above the box: it sits at the foot of the page, where a phone's keyboard is.
          className="absolute bottom-full left-0 z-30 mb-1 w-64 max-w-full overflow-hidden rounded-lg border border-ash bg-paper-raised py-1 shadow-float"
        >
          {options.map((member, i) => (
            <li
              key={member.email}
              id={`${listId}-${i}`}
              // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: an option in it
              role="option"
              tabIndex={-1}
              aria-selected={i === index}
              data-testid="mention-option"
              // Before the textarea loses focus, so the caret stays where the name goes.
              onMouseDown={(e) => {
                e.preventDefault()
                pick(member)
              }}
              onMouseEnter={() => setActive(i)}
              className={`flex cursor-pointer items-baseline gap-2 px-3 py-1.5 text-sm ${
                i === index ? 'bg-ember-wash text-ember-strong' : 'text-ink'
              }`}
            >
              <span className="truncate font-medium">{member.name || member.handle}</span>
              <span className="truncate text-xs text-ink-faint">@{member.handle}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
