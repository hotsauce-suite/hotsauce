import { MAX_THEME_PROMPT, MAX_THEMES, type Theme } from '@hotsauce/format'
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { HotsauceApiError } from '../api/client'
import { type SavedTheme, themesApi } from '../api/themes'
import { primaryButton, secondaryButton } from '../apps/meetings/components/common'
import {
  chooseTheme,
  currentTheme,
  customChoice,
  customIdOf,
  endPreview,
  previewTheme,
  THEME_CHOSEN,
  type ThemeChoice,
} from '../lib/theme'
import { SwitchFxSettings } from './SwitchFxSettings'

// Settings → Appearance: light, dark, the device's, or a theme of the member's own made from a
// description (docs/PLAN-ai-themes.md).

const BUILT_IN: { value: ThemeChoice; label: string }[] = [
  { value: 'system', label: 'Match my device' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

function messageOf(err: unknown): string {
  return err instanceof HotsauceApiError || err instanceof Error ? err.message : String(err)
}

/** A small picture of a theme: its paper, text and accent. */
function Swatch({ theme }: { theme: Theme }) {
  const c = theme.colors
  return (
    <span
      aria-hidden
      className="flex h-9 w-14 shrink-0 items-center justify-center gap-1 rounded-md border"
      style={{ background: c.paper, borderColor: c.ash }}
    >
      <span
        className="text-sm font-semibold"
        style={{ color: c.ink, fontFamily: `"${theme.fonts.display}", serif` }}
      >
        Aa
      </span>
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: c.accent }} />
    </span>
  )
}

/**
 * When this browser shows a theme of the member's own that their account no longer has (deleted
 * on another device), goes back to the device's look. Quiet when offline.
 */
export async function forgetDeletedTheme(): Promise<void> {
  const id = customIdOf(currentTheme())
  if (!id) return
  try {
    const { themes } = await themesApi.list()
    if (!themes.some((t) => t.id === id) && customIdOf(currentTheme()) === id) chooseTheme('system')
  } catch {
    // Offline or signed out: keep what's painted.
  }
}

export function AppearanceSettings() {
  const [choice, setChoice] = useState<ThemeChoice>(currentTheme)
  const [themes, setThemes] = useState<SavedTheme[] | null>(null)
  const [canGenerate, setCanGenerate] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await themesApi.list()
      setThemes(res.themes)
      setCanGenerate(res.canGenerate)
      setLoadError(null)
      // The theme in use here was deleted on another device: back to the device's look (R9).
      const id = customIdOf(currentTheme())
      if (id && !res.themes.some((t) => t.id === id)) {
        chooseTheme('system')
        setChoice('system')
      }
    } catch (err) {
      setLoadError(messageOf(err))
      setThemes([])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Bumped whenever the member picks a look, which ends any preview (and drops one still coming).
  const [picks, setPicks] = useState(0)
  const pick = (value: ThemeChoice, theme?: Theme) => chooseTheme(value, theme)
  // Every choice lands here, the account menu's switch included.
  useEffect(() => {
    const chosen = () => {
      setChoice(currentTheme())
      setPicks((n) => n + 1)
    }
    window.addEventListener(THEME_CHOSEN, chosen)
    return () => window.removeEventListener(THEME_CHOSEN, chosen)
  }, [])

  return (
    <>
      <fieldset data-testid="theme-picker">
        <legend className="font-display text-[1.6rem] font-semibold tracking-tight">
          Appearance
        </legend>
        <p className="mt-2 text-ink-soft">
          Light, dark, or a theme of your own. Your themes follow you to every device; which look is
          on is up to each device.
        </p>
        <div className="mt-4 inline-flex flex-wrap rounded-xl border border-ash bg-paper-sunk p-1">
          {BUILT_IN.map((option) => {
            const on = choice === option.value
            return (
              <label
                key={option.value}
                className={`cursor-pointer rounded-lg px-3.5 py-1.5 text-sm transition-colors has-[:focus-visible]:shadow-[var(--focus-ring)] ${
                  on
                    ? 'bg-paper-raised font-medium text-ink shadow-sm'
                    : 'text-ink-soft hover:text-ink'
                }`}
              >
                <input
                  type="radio"
                  name="theme"
                  value={option.value}
                  checked={on}
                  data-testid={`theme-${option.value}`}
                  onChange={() => pick(option.value)}
                  className="sr-only"
                />
                {option.label}
              </label>
            )
          })}
        </div>

        {themes && themes.length > 0 ? (
          <ul data-testid="own-themes" className="mt-4 grid gap-2 sm:grid-cols-2">
            {themes.map((t) => (
              <OwnTheme
                key={t.id}
                saved={t}
                on={choice === customChoice(t.id)}
                onPick={() => pick(customChoice(t.id), t.theme)}
                onRenamed={(name) =>
                  setThemes(
                    (list) => list?.map((x) => (x.id === t.id ? { ...x, name } : x)) ?? null,
                  )
                }
                onDeleted={() => {
                  setThemes((list) => list?.filter((x) => x.id !== t.id) ?? null)
                  if (choice === customChoice(t.id)) pick('system')
                }}
              />
            ))}
          </ul>
        ) : null}
        {loadError ? (
          <p role="alert" className="mt-3 text-sm text-ember-strong">
            Couldn't load your themes: {loadError}
          </p>
        ) : null}

        {themes ? (
          <MakeTheme
            picks={picks}
            canGenerate={canGenerate}
            full={themes.length >= MAX_THEMES}
            onKept={(saved) => {
              setThemes((list) => [saved, ...(list ?? [])])
              pick(customChoice(saved.id), saved.theme)
            }}
          />
        ) : null}
      </fieldset>
      <SwitchFxSettings />
    </>
  )
}

function OwnTheme(props: {
  saved: SavedTheme
  on: boolean
  onPick: () => void
  onRenamed: (name: string) => void
  onDeleted: () => void
}) {
  const { saved, on } = props
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(saved.name)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const rename = async (e: FormEvent) => {
    e.preventDefault()
    const next = name.trim()
    if (!next || next === saved.name) {
      setRenaming(false)
      setName(saved.name)
      return
    }
    try {
      await themesApi.rename(saved.id, next)
      props.onRenamed(next)
      setRenaming(false)
      setError(null)
    } catch (err) {
      setError(messageOf(err))
    }
  }

  const remove = async () => {
    try {
      await themesApi.remove(saved.id)
      props.onDeleted()
    } catch (err) {
      setError(messageOf(err))
      setConfirming(false)
    }
  }

  return (
    <li
      data-testid="own-theme"
      className={`rounded-xl border p-2.5 ${on ? 'border-ember bg-paper-raised' : 'border-ash'}`}
    >
      <div className="flex items-center gap-3">
        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg has-[:focus-visible]:shadow-[var(--focus-ring)]">
          <input
            type="radio"
            name="theme"
            checked={on}
            onChange={props.onPick}
            className="sr-only"
            aria-label={saved.name}
          />
          <Swatch theme={saved.theme} />
          {renaming ? null : (
            <span className="min-w-0">
              <span
                className={`block truncate text-sm ${on ? 'font-medium text-ink' : 'text-ink-soft'}`}
              >
                {saved.name}
              </span>
              {saved.prompt ? (
                <span className="block truncate text-xs text-ink-faint" title={saved.prompt}>
                  “{saved.prompt}”
                </span>
              ) : null}
            </span>
          )}
        </label>
        {renaming ? (
          <form onSubmit={rename} className="flex flex-1 items-center gap-2">
            <input
              // biome-ignore lint/a11y/noAutofocus: the member just asked to rename it
              autoFocus
              aria-label="Theme name"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setRenaming(false)
                  setName(saved.name)
                }
              }}
              className="min-w-0 flex-1 rounded-md border border-ash bg-paper-raised px-2 py-1 text-sm"
            />
            <button type="submit" className="text-sm text-ember-strong hover:underline">
              Save
            </button>
          </form>
        ) : null}
      </div>
      {renaming ? null : (
        <div className="mt-1.5 flex gap-3 pl-[4.25rem] text-xs">
          {confirming ? (
            <>
              <span className="text-ink-soft">Delete this theme?</span>
              <button type="button" onClick={remove} className="text-ember-strong hover:underline">
                Delete
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="text-ink-soft hover:underline"
              >
                Keep it
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setRenaming(true)}
                className="text-ink-soft hover:text-ink hover:underline"
              >
                Rename
              </button>
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="text-ink-soft hover:text-ink hover:underline"
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}
      {error ? (
        <p role="alert" className="mt-1 text-xs text-ember-strong">
          {error}
        </p>
      ) : null}
    </li>
  )
}

/** The description box, the preview, and Keep or Discard. */
function MakeTheme(props: {
  /** Changes when the member picks a look elsewhere: the preview is over. */
  picks: number
  canGenerate: boolean
  full: boolean
  onKept: (saved: SavedTheme) => void
}) {
  const [prompt, setPrompt] = useState('')
  const [preview, setPreview] = useState<{ theme: Theme; prompts: string[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const previewing = useRef(false)
  // Which make is current: an answer for an older one (or after leaving Settings) is dropped.
  const seq = useRef(0)

  // Leaving Settings mid-preview puts the member's look back, and drops a theme still coming.
  useEffect(
    () => () => {
      seq.current += 1
      if (previewing.current) endPreview()
    },
    [],
  )

  // Picking another look ends the preview; that look is already on screen.
  const { picks } = props
  useEffect(() => {
    if (picks === 0) return
    seq.current += 1
    previewing.current = false
    setPreview(null)
    setBusy(false)
  }, [picks])

  if (!props.canGenerate) {
    return (
      <p data-testid="theme-no-ai" className="mt-5 text-sm text-ink-soft">
        Making a theme from a description needs AI, which isn't set up here. An admin can add an
        Anthropic key in{' '}
        <a href="/settings/organization/ai" className="text-ember-strong hover:underline">
          Settings → AI
        </a>
        .
      </p>
    )
  }

  const make = async (e: FormEvent) => {
    e.preventDefault()
    const words = prompt.trim()
    if (!words || busy) return
    setBusy(true)
    setError(null)
    const mine = ++seq.current
    try {
      const { theme } = await themesApi.generate(words, preview?.theme)
      if (mine !== seq.current) return
      previewTheme(theme)
      previewing.current = true
      setPreview({ theme, prompts: [...(preview?.prompts ?? []), words] })
      setPrompt('')
    } catch (err) {
      if (mine === seq.current) setError(messageOf(err))
    } finally {
      if (mine === seq.current) setBusy(false)
    }
  }

  const discard = () => {
    previewing.current = false
    endPreview()
    setPreview(null)
    setError(null)
  }

  const keep = async () => {
    if (!preview) return
    setBusy(true)
    try {
      const { theme: saved } = await themesApi.save({
        name: preview.theme.name,
        prompt: preview.prompts.join(', then '),
        theme: preview.theme,
      })
      previewing.current = false
      setPreview(null)
      props.onKept(saved)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="make-theme" className="mt-6">
      <h3 className="font-medium text-ink">Make a theme</h3>
      {preview ? (
        <div
          data-testid="theme-preview"
          className="mt-2 flex flex-wrap items-center gap-3 rounded-xl border border-ember bg-paper-raised p-3"
        >
          <Swatch theme={preview.theme} />
          <p className="min-w-0 flex-1 text-sm text-ink">
            Previewing <b>{preview.theme.name}</b>. Keep it, or describe a change below.
          </p>
          <button
            type="button"
            className={primaryButton}
            onClick={keep}
            disabled={busy || props.full}
            data-testid="theme-keep"
          >
            Keep
          </button>
          <button type="button" className={secondaryButton} onClick={discard} disabled={busy}>
            Discard
          </button>
        </div>
      ) : (
        <p className="mt-1 text-sm text-ink-soft">
          Describe a look in your own words. The whole app changes so you can try it before you keep
          it.
        </p>
      )}
      {props.full ? (
        <p className="mt-2 text-sm text-ink-soft" data-testid="themes-full">
          You have {MAX_THEMES} themes, the most there can be. Delete one to keep a new one.
        </p>
      ) : null}
      <form onSubmit={make} className="mt-3 flex flex-wrap gap-2">
        <input
          data-testid="theme-prompt"
          aria-label={preview ? 'Describe a change' : 'Describe a theme'}
          value={prompt}
          maxLength={MAX_THEME_PROMPT}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={
            preview
              ? 'A change, like “darker” or “a warmer accent”'
              : 'Like “calm forest greens” or “a 1970s terminal”'
          }
          className="min-w-0 flex-1 rounded-lg border border-ash bg-paper-raised px-3 py-2 text-sm focus:border-ember focus:outline-none"
        />
        <button
          type="submit"
          className={preview ? secondaryButton : primaryButton}
          disabled={busy || !prompt.trim()}
          data-testid="theme-make"
        >
          {busy ? 'Designing…' : preview ? 'Change it' : 'Make theme'}
        </button>
      </form>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
    </div>
  )
}
