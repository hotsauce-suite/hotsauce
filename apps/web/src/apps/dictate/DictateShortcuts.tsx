import { useCallback, useEffect, useRef, useState } from 'react'
import { HotsauceApiError } from '../../api/client'
import { type DictationSettings, dictationApi, type SendKey } from '../../api/dictation'
import { forgetDictateChoices } from '../../components/DictateButton'
import {
  playDictateSound,
  SOUND_THEME_LABELS,
  SOUND_THEMES,
  type SoundTheme,
} from '../../lib/dictateSounds'
import { secondaryButton } from '../meetings/components/common'

export const SEND_KEY_LABELS: Record<SendKey, string> = {
  space: 'Space',
  return: 'Return',
  tab: 'Tab',
  off: 'Off',
}
const SEND_KEYS: SendKey[] = ['space', 'return', 'tab', 'off']

/**
 * The member's send key and sounds (docs/PLAN-dictate-send-and-sounds.md, R3, R4), shown on the
 * Dictate page and on Settings → This Mac. Kept on the server, so the web and every Mac follow
 * one choice; saved as soon as it is picked.
 */
export function DictateShortcuts({ compact = false }: { compact?: boolean }) {
  const [settings, setSettings] = useState<DictationSettings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  // The newest pick in each group, so an older save that answers late can't undo it.
  const latest = useRef({ sendKey: 0, sounds: 0 })

  const load = useCallback(() => {
    setLoadError(null)
    dictationApi.settings().then(setSettings, (err: unknown) => setLoadError(messageOf(err)))
  }, [])
  useEffect(() => {
    load()
  }, [load])

  if (!settings) {
    return loadError ? (
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <p role="alert" className="text-sm text-ember-strong">
          {loadError}
        </p>
        <button type="button" onClick={load} className={`${secondaryButton} h-8 px-3`}>
          Try again
        </button>
      </div>
    ) : (
      <p className="mt-3 text-sm text-ink-faint">Loading…</p>
    )
  }

  // Never disabled while saving: arrow keys move through a radio group, and a disabled radio would
  // throw the keyboard's focus out of it.
  const choose = async (choice: { sendKey: SendKey } | { sounds: SoundTheme }) => {
    const group = 'sendKey' in choice ? 'sendKey' : 'sounds'
    const value = 'sendKey' in choice ? choice.sendKey : choice.sounds
    if (settings[group] === value) return
    const before = settings[group]
    const pick = ++latest.current[group]
    setSettings((s) => (s ? { ...s, ...choice } : s))
    setSaved(false)
    setError(null)
    try {
      const next = await dictationApi.setChoice(choice)
      forgetDictateChoices()
      if (pick !== latest.current[group]) return
      setSettings((s) => (s ? { ...s, [group]: next[group] } : next))
      setSaved(true)
    } catch (err) {
      if (pick !== latest.current[group]) return
      setSettings((s) => (s ? { ...s, [group]: before } : s))
      setError(messageOf(err))
    }
  }

  const legendClass = compact
    ? 'font-medium text-ink'
    : 'font-display text-base font-semibold text-ink'
  return (
    <div
      data-testid="dictate-shortcuts"
      className={compact ? '' : 'mt-4 rounded-xl border border-ash bg-paper-raised/60 p-4'}
    >
      <fieldset>
        <legend className={legendClass}>Send key</legend>
        <p className="mt-1 text-sm text-ink-soft">
          Press it while you dictate to stop, put the words in and press Return, so a chat message
          goes out. In the browser it adds the words without sending. Holding ⇧ as you finish does
          the same in the Mac app.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {SEND_KEYS.map((key) => (
            <Pill
              key={key}
              group="dictate-send-key"
              testId={`dictate-send-key-${key}`}
              label={SEND_KEY_LABELS[key]}
              checked={settings.sendKey === key}
              onPick={() => void choose({ sendKey: key })}
            />
          ))}
        </div>
      </fieldset>

      <fieldset className="mt-5">
        <legend className={legendClass}>Sounds</legend>
        <p className="mt-1 text-sm text-ink-soft">
          A short sound when dictation starts, stops, sends or is cancelled. Picking one plays it.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {SOUND_THEMES.map((theme) => (
            <Pill
              key={theme}
              group="dictate-sounds"
              testId={`dictate-sounds-${theme}`}
              label={SOUND_THEME_LABELS[theme]}
              checked={settings.sounds === theme}
              onPick={() => {
                playDictateSound(theme, 'start')
                void choose({ sounds: theme })
              }}
            />
          ))}
        </div>
      </fieldset>

      <p aria-live="polite" className="mt-3 min-h-4 text-xs text-ink-soft">
        {saved ? 'Saved. Your next dictation uses it, here and in the Mac app.' : ''}
      </p>
      {error ? (
        <p role="alert" className="mt-1 text-xs text-ember-strong">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function Pill({
  group,
  testId,
  label,
  checked,
  onPick,
}: {
  group: string
  testId: string
  label: string
  checked: boolean
  onPick: () => void
}) {
  return (
    <label
      data-testid={testId}
      className="flex cursor-pointer items-center gap-2 rounded-lg border border-ash bg-paper px-3 py-1.5 text-sm has-[:checked]:border-ember has-[:checked]:bg-ember-wash/40 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ember"
    >
      <input
        type="radio"
        name={group}
        value={label}
        checked={checked}
        onChange={onPick}
        className="accent-ember"
      />
      <span className="font-medium text-ink">{label}</span>
    </label>
  )
}

function messageOf(err: unknown): string {
  return err instanceof HotsauceApiError ? err.message : 'Something went wrong; try again.'
}
