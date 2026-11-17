import type { ReactNode } from 'react'
import type { FilledValue, SignField } from '../../api/sign'
import { primaryButton } from '../meetings/components/common'

/** The fields someone still has to fill before they can finish. */
export function missingFields(mine: SignField[], values: Record<string, FilledValue>): SignField[] {
  return mine.filter((f) => {
    const v = values[f.id]
    if (f.type === 'signature' || f.type === 'initials') return !v?.value && !v?.image
    if (f.type === 'text') return f.required && !v?.value?.trim()
    if (f.type === 'checkbox') return f.required && v?.checked !== true
    return false
  })
}

/** The bar above the pages while someone signs: what's left, the consent, and Finish. */
export function SigningPanel({
  missing,
  consent,
  onConsent,
  busy,
  onFinish,
  children,
}: {
  missing: number
  consent: boolean
  onConsent: (v: boolean) => void
  busy: boolean
  onFinish: () => void
  /** More buttons beside Finish (Back to fields, Decline). */
  children?: ReactNode
}) {
  return (
    <section
      className="sticky top-0 z-10 flex flex-col gap-3 rounded-xl bg-paper-raised p-4 shadow-sm ring-1 ring-ash"
      aria-label="Signing"
      data-testid="sign-panel"
    >
      <p className="text-sm text-ink">
        Click each highlighted field to fill it in.{' '}
        {missing > 0 ? `${missing} left.` : 'All done: agree below and finish.'}
      </p>
      <label className="flex items-start gap-2 text-sm text-ink">
        <input
          type="checkbox"
          className="mt-1"
          checked={consent}
          onChange={(e) => onConsent(e.target.checked)}
          data-testid="sign-consent"
        />
        <span>
          I agree to sign this document electronically, and that my electronic signature counts the
          same as one on paper.
        </span>
      </label>
      <div className="flex flex-wrap gap-2">
        {children}
        <button
          type="button"
          className={primaryButton}
          disabled={busy || !consent || missing > 0}
          onClick={onFinish}
          data-testid="sign-finish"
        >
          {busy ? 'Sealing…' : 'Finish signing'}
        </button>
      </div>
    </section>
  )
}
