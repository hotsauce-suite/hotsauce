// Docs → Kept on this device (docs/PLAN-offline.md, A4.4): doc edits this member made offline that
// are still only on this device. Waiting ones go up by themselves when the connection is back;
// ones the server refused (the doc was moved, renamed or deleted meanwhile) stay here to copy.

import { useState } from 'react'
import { Link } from 'react-router'
import { product } from '../brand/product'
import { removeDraft, type StoredDraft, strandedDrafts, waitingDrafts } from '../lib/drafts'
import { rememberedMember } from '../lib/offlineStart'
import { displayName, docUrl } from '../lib/paths'
import { relativeTime } from '../lib/time'
import { useSession } from '../state/session'

/** The signed-in member's id, or the one this device remembers while offline. */
export function keptOwner(sessionUserId: string | undefined): string | null {
  return sessionUserId ?? rememberedMember()?.userId ?? null
}

export function keptCount(owner: string | null): number {
  return waitingDrafts(owner).length + strandedDrafts(owner).length
}

export default function KeptRoute() {
  const session = useSession()
  const owner = keptOwner(session.me?.principal.userId)
  const [, setVersion] = useState(0)
  const refresh = () => setVersion((v) => v + 1)
  const stranded = strandedDrafts(owner)
  const waiting = waitingDrafts(owner)

  return (
    <div
      data-testid="kept-page"
      className="mx-auto w-full max-w-[var(--measure)] overflow-y-auto px-6 py-12"
    >
      <h1 className="font-display text-2xl font-semibold text-ink">Kept on this device</h1>
      <p className="mt-2 text-ink-soft">
        Doc edits you made offline that are only on this device so far. Signing out doesn’t remove
        them; they stay with your account on this device.
      </p>
      {stranded.length === 0 && waiting.length === 0 ? (
        <p data-testid="kept-empty" className="mt-8 text-ink-soft">
          Nothing here: everything you wrote is saved in {product()}.
        </p>
      ) : null}
      {stranded.length > 0 ? (
        <section className="mt-8">
          <h2 className="font-medium text-ink">Couldn’t be saved</h2>
          <p className="mt-1 text-sm text-ink-soft">
            The doc was moved, renamed or deleted while you were offline. Copy your text into the
            doc at its new place, or into a new doc.
          </p>
          <ul className="mt-3 flex flex-col gap-3">
            {stranded.map((draft) => (
              <KeptItem key={draft.key} draft={draft} onGone={refresh} />
            ))}
          </ul>
        </section>
      ) : null}
      {waiting.length > 0 ? (
        <section className="mt-8">
          <h2 className="font-medium text-ink">Waiting to be sent</h2>
          <p className="mt-1 text-sm text-ink-soft">
            These go up by themselves when you’re back online.
          </p>
          <ul className="mt-3 flex flex-col gap-3">
            {waiting.map((draft) => (
              <KeptItem key={draft.key} draft={draft} onGone={refresh} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

function KeptItem({ draft, onGone }: { draft: StoredDraft; onGone: () => void }) {
  const [copied, setCopied] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const button =
    'rounded-md border border-ash px-2.5 py-1 text-xs font-medium text-ink hover:bg-paper-sunk'
  return (
    <li data-testid="kept-item" className="rounded-lg border border-ash bg-paper-raised/70 p-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium text-ink">{displayName(draft.path)}</span>
        <span className="text-xs text-ink-faint">
          {draft.space} · {draft.path} · {draft.savedAt ? relativeTime(draft.savedAt) : 'earlier'}
        </span>
      </div>
      <pre className="mt-2 max-h-40 overflow-auto rounded bg-paper-sunk/70 p-2 text-xs whitespace-pre-wrap text-ink-soft">
        {draft.content}
      </pre>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          className={button}
          onClick={() =>
            void navigator.clipboard.writeText(draft.content).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          {copied ? 'Copied' : 'Copy text'}
        </button>
        {draft.state === 'waiting' ? (
          <Link to={docUrl(draft.space, draft.path)} className={button}>
            Open
          </Link>
        ) : null}
        {confirming ? (
          <button
            type="button"
            data-testid="kept-discard-confirm"
            className={`${button} border-ember text-ember-strong`}
            onClick={() => {
              removeDraft(draft.key)
              onGone()
            }}
          >
            Delete it from this device
          </button>
        ) : (
          <button
            type="button"
            data-testid="kept-discard"
            className={button}
            onClick={() => setConfirming(true)}
          >
            Discard…
          </button>
        )}
      </div>
    </li>
  )
}
