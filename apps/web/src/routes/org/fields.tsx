import { type ReactNode, useId, useState } from 'react'
import { HearthApiError } from '../../api/client'
import { Icon } from '../../components/Icon'

/** Small building blocks shared by the setup wizard and Settings → Organization. */

export const inputClass =
  'h-10 w-full rounded-lg border border-ash-strong bg-paper-raised px-3 text-ink placeholder:text-ink-faint focus:border-ember focus:outline-none disabled:opacity-60'

export function Field({
  label,
  hint,
  children,
  locked,
}: {
  label: string
  hint?: ReactNode
  children: (id: string) => ReactNode
  locked?: boolean | undefined
}) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
        {locked ? (
          <span className="ml-2 font-normal text-ink-faint">(set by the server’s environment)</span>
        ) : null}
      </label>
      {children(id)}
      {hint ? <p className="text-xs leading-relaxed text-ink-faint">{hint}</p> : null}
    </div>
  )
}

/**
 * A key field. It never shows a saved value: only that one is saved and its last four characters.
 * Typing a new value replaces it on save.
 */
export function SecretField({
  label,
  hint,
  status,
  value,
  onChange,
  placeholder,
  testId,
}: {
  label: string
  hint?: ReactNode
  status: { set: boolean; last4: string | null; source: 'env' | 'saved' | null }
  value: string
  onChange: (v: string) => void
  placeholder?: string
  testId?: string
}) {
  const [show, setShow] = useState(false)
  const locked = status.source === 'env'
  return (
    <Field label={label} hint={hint} locked={locked}>
      {(id) => (
        <div className="flex gap-2">
          <input
            id={id}
            data-testid={testId}
            type={show ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            disabled={locked}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={
              status.set
                ? `Saved, ending in …${status.last4}. Paste a new one to replace it.`
                : placeholder
            }
            className={`${inputClass} font-mono text-sm`}
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="shrink-0 rounded-lg border border-ash px-3 text-xs text-ink-soft hover:text-ink"
          >
            {show ? 'Hide' : 'Show'}
          </button>
        </div>
      )}
    </Field>
  )
}

/** A numbered instruction with a button that opens the exact page. */
export function StepLink({
  n,
  children,
  href,
  cta,
}: {
  n: number
  children: ReactNode
  href?: string
  cta?: string
}) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-ember-wash text-xs font-semibold text-ember-strong">
        {n}
      </span>
      <div className="min-w-0 flex-1 text-sm leading-relaxed text-ink-soft">{children}</div>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-ash-strong px-3 py-1.5 text-xs font-medium text-ink hover:border-ember"
        >
          {cta ?? 'Open'}
          <Icon name="external" className="size-3.5" />
        </a>
      ) : null}
    </li>
  )
}

/** A value to paste somewhere else, with a copy button. */
export function CopyValue({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <span className="mt-1 flex items-center gap-2 rounded-md border border-ash bg-paper-sunk px-2 py-1">
      {label ? <span className="shrink-0 text-xs text-ink-faint">{label}</span> : null}
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{value}</code>
      <button
        type="button"
        aria-label={`Copy ${label ?? value}`}
        onClick={() =>
          void navigator.clipboard?.writeText(value).then(
            () => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            },
            () => {},
          )
        }
        className="shrink-0 rounded p-1 text-ink-faint hover:text-ink"
      >
        <Icon name={copied ? 'check' : 'copy'} className="size-3.5" />
      </button>
    </span>
  )
}

/** The answer from a Test button. */
export function TestResult({ result }: { result: { ok: boolean; message: string } | null }) {
  if (!result) return null
  return (
    <p
      role="status"
      data-testid="test-result"
      data-ok={result.ok}
      className={`flex items-start gap-1.5 text-sm ${result.ok ? 'text-moss' : 'text-ember-strong'}`}
    >
      <Icon name={result.ok ? 'check' : 'close'} className="mt-0.5 size-4 shrink-0" />
      {result.message}
    </p>
  )
}

export function Callout({
  children,
  tone = 'info',
}: {
  children: ReactNode
  tone?: 'info' | 'warn'
}) {
  return (
    <div
      className={`rounded-xl border p-3.5 text-sm leading-relaxed ${
        tone === 'warn'
          ? 'border-ember/40 bg-ember-wash text-ink'
          : 'border-ash bg-paper-sunk/60 text-ink-soft'
      }`}
    >
      {children}
    </div>
  )
}

export function messageOf(err: unknown): string {
  return err instanceof HearthApiError || err instanceof Error ? err.message : String(err)
}
