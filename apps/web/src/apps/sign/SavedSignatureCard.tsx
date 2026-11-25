import { useState } from 'react'
import type { MarkKind } from '../../api/sign'
import { useSession } from '../../state/session'
import { MarkPreview, SignatureDialog } from './SignaturePad'
import { useSavedSignatures } from './savedSignatures'

const LABEL: Record<MarkKind, string> = { signature: 'Signature', initials: 'Initials' }

/**
 * "Your signature" on the Sign home page: the saved signature and initials, each with Replace
 * and Delete (docs/PLAN-sign-saved-signature.md R7). Kept in the member's personal space.
 */
export function SavedSignatureCard() {
  const { me, notify } = useSession()
  const { saved, failed, keep, forget } = useSavedSignatures()
  const [editing, setEditing] = useState<MarkKind | null>(null)
  const name = me?.principal.name || me?.principal.email || ''

  return (
    <section
      className="mb-4 rounded-xl bg-paper-raised p-4 ring-1 ring-ash"
      aria-label="Your signature"
      data-testid="saved-signature-card"
    >
      <h2 className="font-medium text-ink">Your signature</h2>
      <p className="mt-1 text-sm text-ink-soft">
        Save your signature and initials once, typed, drawn or from a photo, and use them with one
        click whenever you sign. Only you can see them.
      </p>
      {failed ? (
        <p className="mt-2 text-sm text-ink" role="alert">
          Your saved signature couldn’t be loaded. Reload the page to try again.
        </p>
      ) : null}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {(['signature', 'initials'] as const).map((kind) => {
          const mark = saved?.[kind] ?? null
          return (
            <div key={kind} className="flex flex-col gap-2" data-testid={`saved-${kind}`}>
              <span className="text-xs text-ink-faint">{LABEL[kind]}</span>
              <div className="flex h-24 items-center justify-center rounded-lg border border-ash-strong bg-white px-3">
                {mark ? (
                  <MarkPreview mark={mark} className="max-h-20" />
                ) : (
                  <span className="text-sm text-ink-faint">
                    {saved ? 'None saved yet' : 'Loading…'}
                  </span>
                )}
              </div>
              <div className="flex gap-3 text-sm">
                <button
                  type="button"
                  className="text-ink underline"
                  disabled={!saved}
                  onClick={() => setEditing(kind)}
                  data-testid={`saved-${kind}-replace`}
                >
                  {mark ? 'Replace' : 'Add'}
                </button>
                {mark ? (
                  <button
                    type="button"
                    className="text-ink-soft underline"
                    onClick={() =>
                      void forget(kind).then((ok) =>
                        notify(ok ? `Deleted your saved ${kind}` : `Couldn’t delete your ${kind}`),
                      )
                    }
                    data-testid={`saved-${kind}-delete`}
                  >
                    Delete
                  </button>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
      {editing ? (
        <SignatureDialog
          kind={editing}
          name={name}
          saving
          onClose={() => setEditing(null)}
          onDone={(s) => {
            const kind = editing
            setEditing(null)
            void keep(kind, s).then((ok) =>
              notify(ok ? `Saved your ${kind}` : `Couldn’t save your ${kind}`),
            )
          }}
        />
      ) : null}
    </section>
  )
}
