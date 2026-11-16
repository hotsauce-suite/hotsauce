// One For you entry per item: who named the member, the comment, when, and Done or Later. The page
// shows them all; Today's tile shows the first few.

import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import type { ForYouItem } from '../../api/forYou'
import { Icon } from '../../components/Icon'
import { Menu, type MenuAnchor, MenuItem } from '../../components/Menu'
import { relativeTime } from '../../lib/time'
import { browserZone, markForYou } from './store'

const KIND_LABEL: Record<string, string> = { task: 'Task', meeting: 'Meeting notes' }

export interface ForYouToast {
  message: string
  undo?: () => void
}

export function ForYouList({
  items,
  canMark,
  onToast,
  compact = false,
}: {
  items: ForYouItem[]
  canMark: boolean
  onToast: (toast: ForYouToast | null) => void
  /** Today's tile: one line of the comment, smaller buttons. */
  compact?: boolean
}) {
  return (
    <ul className="flex flex-col gap-1" data-testid="for-you-list">
      {items.map((item) => (
        <ForYouRow
          key={item.item}
          item={item}
          canMark={canMark}
          onToast={onToast}
          compact={compact}
        />
      ))}
    </ul>
  )
}

function ForYouRow({
  item,
  canMark,
  onToast,
  compact,
}: {
  item: ForYouItem
  canMark: boolean
  onToast: (toast: ForYouToast | null) => void
  compact: boolean
}) {
  const [menu, setMenu] = useState<MenuAnchor | null>(null)
  const who = item.comment.name || item.comment.author
  const fail = (what: string) => () =>
    onToast({ message: `${what} didn’t work. Check your connection and try again.` })
  const done = () => {
    void markForYou(item.item, { action: 'done' }).then(
      () =>
        onToast({
          message: `Done: ${item.title}`,
          undo: () => void markForYou(item.item, { action: 'undone' }).catch(fail('Undo')),
        }),
      fail('Done'),
    )
  }
  const later = (when: 'tomorrow' | 'monday') => {
    setMenu(null)
    void markForYou(item.item, { action: 'later', when, zone: browserZone() }).then(
      () =>
        onToast({
          message: when === 'tomorrow' ? 'Back tomorrow at 9 AM' : 'Back next Monday at 9 AM',
        }),
      fail('Later'),
    )
  }
  return (
    <li
      data-testid="for-you-item"
      data-unseen={item.unseen ? 'true' : undefined}
      className="group flex items-start gap-2 rounded-lg px-2 py-2 hover:bg-paper-sunk"
    >
      <span
        aria-hidden="true"
        className={`mt-2 size-2 shrink-0 rounded-full ${item.unseen ? 'bg-ember' : 'bg-transparent'}`}
      />
      <Link to={item.url} className="min-w-0 flex-1" data-testid="for-you-open">
        <span className="flex items-baseline gap-2">
          <span
            className={`min-w-0 truncate text-sm text-ink ${item.unseen ? 'font-semibold' : 'font-medium'}`}
          >
            {item.title}
          </span>
          {KIND_LABEL[item.kind] ? (
            <span className="shrink-0 text-xs text-ink-faint">{KIND_LABEL[item.kind]}</span>
          ) : null}
        </span>
        <span className="block text-xs text-ink-faint">
          {who} mentioned you · {relativeTime(item.at)}
          {item.mentions > 1 ? ` · ${item.mentions} mentions` : ''}
          {item.unseen ? <span className="sr-only"> · new</span> : null}
        </span>
        <span
          className={`mt-0.5 block text-sm text-ink-soft ${compact ? 'truncate' : 'line-clamp-2'}`}
        >
          {item.comment.text}
        </span>
      </Link>
      {canMark ? (
        <span className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            data-testid="for-you-done"
            onClick={done}
            aria-label={`Done: ${item.title}`}
            title="Done: take it off the list"
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-ink-soft hover:bg-paper-raised hover:text-ink"
          >
            <Icon name="check" className="size-3.5" />
            {compact ? null : 'Done'}
          </button>
          <button
            type="button"
            data-testid="for-you-later"
            aria-label={`Later: ${item.title}`}
            aria-haspopup="menu"
            title="Later: hide it until 9 AM tomorrow or next Monday"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setMenu({ x: r.right - 200, y: r.bottom + 4 })
            }}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-ink-soft hover:bg-paper-raised hover:text-ink"
          >
            <Icon name="history" className="size-3.5" />
            {compact ? null : 'Later'}
          </button>
        </span>
      ) : null}
      {menu ? (
        <Menu anchor={menu} onClose={() => setMenu(null)} label="Later">
          <MenuItem testId="for-you-later-tomorrow" onSelect={() => later('tomorrow')}>
            Tomorrow at 9 AM
          </MenuItem>
          <MenuItem testId="for-you-later-monday" onSelect={() => later('monday')}>
            Next Monday at 9 AM
          </MenuItem>
        </Menu>
      ) : null}
    </li>
  )
}

/** The small message at the foot of the screen after Done or Later, with Undo after Done. */
export function ForYouToastBar({
  toast,
  onClose,
}: {
  toast: ForYouToast | null
  onClose: () => void
}) {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => close.current(), 6_000)
    return () => clearTimeout(timer)
  }, [toast])
  if (!toast) return null
  return (
    <div
      role="status"
      data-testid="for-you-toast"
      className="fixed bottom-[calc(4.75rem+env(safe-area-inset-bottom))] left-1/2 z-[60] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-4 rounded-lg border border-ash bg-paper-raised px-4 py-2.5 text-sm text-ink shadow-float md:bottom-6"
    >
      <span className="min-w-0 truncate">{toast.message}</span>
      {toast.undo ? (
        <button
          type="button"
          data-testid="for-you-undo"
          className="font-medium text-ember-strong hover:underline"
          onClick={() => {
            toast.undo?.()
            onClose()
          }}
        >
          Undo
        </button>
      ) : null}
    </div>
  )
}
