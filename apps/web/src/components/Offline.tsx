// What the app shows while it can't reach its server (docs/PLAN-offline.md, A3).

import { Link } from 'react-router'
import { product } from '../brand/product'
import { useOnline } from '../lib/connection'
import { waitingDrafts } from '../lib/drafts'
import { displayName, docUrl } from '../lib/paths'

/** The tooltip on anything greyed out offline. */
export const NEEDS_CONNECTION = 'Needs a connection'

/**
 * Props for a control that needs the server: greyed out with "Needs a connection" while offline.
 * `title` is what it says online.
 */
export function needsConnection(online: boolean, title?: string) {
  return online
    ? { ...(title ? { title } : {}) }
    : { disabled: true, title: NEEDS_CONNECTION, 'data-offline': '' }
}

/** The bar across the top of the app while offline. */
export function OfflineBar() {
  const online = useOnline()
  if (online) return null
  return (
    <div
      role="status"
      data-testid="offline-bar"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-ash bg-paper-sunk px-4 py-1.5 text-sm text-ink-soft"
    >
      <span className="flex items-center gap-2 font-medium text-ink">
        <span aria-hidden="true" className="size-2 rounded-full bg-ink-faint" />
        Offline
      </span>
      <span>
        Edits to docs are kept on this device and sent when you’re back. Anything that needs the{' '}
        {product()} server waits until then.
      </span>
    </div>
  )
}

/** A screen opened offline that has nothing on this device yet. */
export function OfflineEmpty() {
  const kept = waitingDrafts()
  return (
    <div data-testid="offline-empty" className="mx-auto max-w-[var(--measure)] px-6 py-16">
      <h1 className="font-display text-2xl font-semibold text-ink">Not available offline yet</h1>
      <p className="mt-2 text-ink-soft">
        This opens once you’re back online. Docs you edited while offline are kept on this device
        and can be opened now.
      </p>
      {kept.length > 0 ? (
        <section className="mt-6">
          <h2 className="text-sm font-medium text-ink-soft">Kept on this device</h2>
          <ul className="mt-2 flex flex-col gap-1">
            {kept.map((draft) => (
              <li key={`${draft.space}:${draft.path}`}>
                <Link to={docUrl(draft.space, draft.path)} className="text-ember-strong underline">
                  {displayName(draft.path)}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
