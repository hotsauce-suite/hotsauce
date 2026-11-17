import { useEffect, useState } from 'react'
import { HotsauceApiError } from '../../api/client'
import { type CleanupChoice, type DictationSettings, dictationApi } from '../../api/dictation'

/**
 * The Dictate page's Models section (docs/PLAN-dictate-models.md, R5): what hears a dictation and
 * what tidies it, and the member's own cleanup choice, saved as soon as it's picked.
 */
export function DictateModels() {
  const [settings, setSettings] = useState<DictationSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    dictationApi.settings().then(setSettings, (err: unknown) => setError(messageOf(err)))
  }, [])

  if (!settings) {
    return error ? (
      <p role="alert" className="mt-4 text-sm text-ember-strong">
        {error}
      </p>
    ) : (
      <p className="mt-4 text-sm text-ink-faint">Loading…</p>
    )
  }

  const { models } = settings
  const cleanupName =
    settings.cleanup === 'off'
      ? 'Off'
      : settings.cleanup === 'careful'
        ? models.careful
        : models.fast
  const choices: Array<{ id: CleanupChoice; label: string; detail: string }> = [
    { id: 'fast', label: 'Fast', detail: `${models.fast}. Quick, and right almost every time.` },
    {
      id: 'careful',
      label: 'Careful',
      detail: `${models.careful}. Better with names and long rambles, about a second slower.`,
    },
    { id: 'off', label: 'Off', detail: 'Your exact words, as heard: no tidying.' },
  ]

  const choose = async (cleanup: CleanupChoice) => {
    if (cleanup === settings.cleanup) return
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      setSettings(await dictationApi.setCleanup(cleanup))
      setSaved(true)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      data-testid="dictate-models"
      className="mt-4 rounded-xl border border-ash bg-paper-raised/60 p-4"
    >
      <dl data-testid="dictate-models-line" className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
        <Model term="Speech" value={models.speech} />
        <Model term="Offline" value={models.offline} />
        <Model term="Cleanup" value={cleanupName} />
      </dl>

      <fieldset className="mt-5" disabled={saving}>
        <legend className="font-display text-base font-semibold text-ink">Cleanup</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {choices.map((c) => (
            <label
              key={c.id}
              data-testid={`dictate-cleanup-${c.id}`}
              className="flex cursor-pointer gap-2 rounded-lg border border-ash bg-paper p-3 text-sm has-[:checked]:border-ember has-[:checked]:bg-ember-wash/40"
            >
              <input
                type="radio"
                name="dictate-cleanup"
                value={c.id}
                checked={settings.cleanup === c.id}
                onChange={() => void choose(c.id)}
                className="mt-0.5 accent-ember"
              />
              <span>
                <span className="block font-medium text-ink">{c.label}</span>
                <span className="block text-ink-soft">{c.detail}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <p className="mt-3 text-xs leading-relaxed text-ink-faint">
        When a Mac can’t reach the server, it writes the dictation up itself and the audio never
        leaves it. The Mac app’s Literal mode skips the tidying on that Mac whatever you pick here.
      </p>
      <p aria-live="polite" className="mt-2 min-h-4 text-xs text-ink-soft">
        {saved ? 'Saved. Your next dictation uses it.' : ''}
      </p>
      {error ? (
        <p role="alert" className="mt-1 text-xs text-ember-strong">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function Model({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex gap-1.5">
      <dt className="text-ink-faint">{term}:</dt>
      <dd className="font-medium text-ink">{value}</dd>
    </div>
  )
}

function messageOf(err: unknown): string {
  return err instanceof HotsauceApiError ? err.message : 'Something went wrong; try again.'
}
