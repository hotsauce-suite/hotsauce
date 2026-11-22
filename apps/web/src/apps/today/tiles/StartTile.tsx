// The Getting started tile (docs/PLAN-getting-started.md): a new member's first few steps, at the
// top of Today until they're done or hidden. Each step is ticked from what is really so, not from
// a click, except "see the docs", which nothing else can show.

import { removeTile, type TodayLayout, type TodayTile, updateTile } from '@hotsauce/format'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { dictationApi } from '../../../api/dictation'
import { type StartHereDoc, type TodayView, todayApi } from '../../../api/today'
import { product } from '../../../brand/product'
import { saveBreakSettings } from '../../../breaks/settings'
import { useBreakSettings } from '../../../breaks/useBreakSettings'
import { Icon } from '../../../components/Icon'
import { MAC_APP_SETTINGS, useMacAppBuild } from '../../../components/MacApp'
import { TOUCH_QUERY, useMediaQuery } from '../../../hooks/useMediaQuery'
import { desktopSignInBridge } from '../../../lib/desktop'
import { installContext } from '../../../lib/install'
import { docUrl } from '../../../lib/paths'
import { music } from '../../../music/player'
import { useMusic } from '../../../music/useMusic'
import { extensionVersion } from '../../meetings/audio/extension'
import { canRunExtension } from '../../meetings/extensionRelease'
import { Card } from './Card'

const CALENDARS = '/settings/connections#calendars'
const APPS = '/settings/apps'
const EXTENSION = '/meetings/extension'

interface Step {
  id: 'calendar' | 'mac' | 'extension' | 'home' | 'docs'
  title: string
  hint: string
  /** Null while it isn't known yet (a request is out). */
  done: boolean | null
  action: ReactNode
}

const stepButton =
  'inline-flex h-7 shrink-0 items-center rounded-md border border-ember/60 px-2.5 text-xs font-medium text-ember-strong hover:border-ember hover:bg-ember/5'

/**
 * Loaded: connected. No grant: not connected. Connected but failing right now (Google down): not
 * known, so it's neither ticked nor offered. An older server doesn't say `connected`; its error
 * counts as not connected, as it always has.
 */
function calendarDone(meetings: TodayView['meetings']): boolean | null {
  if (meetings.error === null) return true
  return meetings.connected === true ? null : false
}

/** Whether the member has the Mac app: true inside it or once a Mac is connected; null while asking. */
function useHasMac(enabled: boolean): boolean | null {
  const inApp = desktopSignInBridge() !== null
  const [connected, setConnected] = useState<boolean | null>(null)
  useEffect(() => {
    if (!enabled || inApp) return
    let cancelled = false
    dictationApi.devices().then(
      (devices) => {
        if (!cancelled) setConnected(devices.length > 0)
      },
      // Not knowing isn't "done": the step stays open.
      () => {
        if (!cancelled) setConnected(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [enabled, inApp])
  return inApp ? true : connected
}

/** Whether the Chrome extension answers on this page: null while asking. */
function useHasExtension(enabled: boolean): boolean | null {
  const [has, setHas] = useState<boolean | null>(null)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void extensionVersion().then((v) => {
      if (!cancelled) setHas(v !== null)
    })
    return () => {
      cancelled = true
    }
  }, [enabled])
  return has
}

/**
 * The doc the team's admin picked to start with (plan H2): undefined while asking, null for none.
 * Not knowing which doc counts as none: Docs itself is still the right place.
 */
function useStartHere(enabled: boolean): StartHereDoc | null | undefined {
  const [doc, setDoc] = useState<StartHereDoc | null | undefined>(undefined)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    todayApi.startHere().then(
      (r) => {
        if (!cancelled) setDoc(r.doc)
      },
      () => {
        if (!cancelled) setDoc(null)
      },
    )
    return () => {
      cancelled = true
    }
  }, [enabled])
  return doc
}

export function StartTile({
  tile,
  layout,
  view,
  editing,
  onChange,
  onFinished,
}: {
  tile: TodayTile
  layout: TodayLayout
  view: TodayView
  editing: boolean
  onChange: (layout: TodayLayout) => void
  /** Every step is done: the page saves the tile away and keeps showing it for this visit. */
  onFinished: (tile: TodayTile) => void
}) {
  const navigate = useNavigate()
  const touch = useMediaQuery(TOUCH_QUERY)
  const inApp = desktopSignInBridge() !== null
  // A server without a Mac build has nothing to download: no Mac step there.
  const hasBuild = useMacAppBuild(!touch && !inApp)
  const hasMac = useHasMac(!touch)
  // The Chrome extension, offered only where it can run: Chrome on a computer, not the Mac app.
  const offersExtension = !touch && !inApp && canRunExtension()
  const hasExtension = useHasExtension(offersExtension)
  // Set as "Open Docs" leaves Today: if that was the last step, "You're set" waits for the next
  // time Today opens, where it can be read, instead of saving the tile away unseen.
  const leaving = useRef(false)
  const startHere = useStartHere(tile.openedDocs !== true)

  const steps: Step[] = [
    {
      id: 'calendar',
      title: 'Connect your calendar',
      hint: 'Your meetings show up here, each with a page for notes.',
      done: calendarDone(view.meetings),
      action: (
        <Link to={CALENDARS} className={stepButton} data-testid="today-start-calendar">
          Connect
        </Link>
      ),
    },
  ]
  if (touch) {
    // Nobody installs the live demo (vite.config.ts).
    if (import.meta.env.MODE !== 'demo')
      steps.push({
        id: 'home',
        title: `Add ${product()} to your Home Screen`,
        hint: 'It opens like an app and can send you reminders.',
        done: installContext().isInstalled,
        action: (
          <Link to={APPS} className={stepButton} data-testid="today-start-home">
            Show me how
          </Link>
        ),
      })
  } else if (inApp || hasBuild !== false) {
    steps.push({
      id: 'mac',
      title: 'Get the Mac app',
      hint: 'Dictate into any app and record any call.',
      done: hasMac === true ? true : hasBuild === null || hasMac === null ? null : false,
      action: (
        <Link to={MAC_APP_SETTINGS} className={stepButton} data-testid="today-start-mac">
          Download
        </Link>
      ),
    })
  }
  if (offersExtension)
    steps.push({
      id: 'extension',
      title: 'Get the Chrome extension',
      hint: 'Notes on Google Meet calls in one click, and pages saved to read later.',
      done: hasExtension,
      action: (
        <Link to={EXTENSION} className={stepButton} data-testid="today-start-extension">
          Get it
        </Link>
      ),
    })
  steps.push({
    id: 'docs',
    title: 'See where the team’s work lives',
    hint: startHere ? `Start with “${startHere.title}”.` : 'Shared docs, grouped by space.',
    // Until it's known which doc to open, the step offers nothing: a click then would open
    // Docs and tick the step, and the picked doc would never be offered.
    done: tile.openedDocs === true ? true : startHere === undefined ? null : false,
    action: (
      <button
        type="button"
        className={stepButton}
        data-testid="today-start-docs"
        onClick={() => {
          leaving.current = true
          onChange(updateTile(layout, { ...tile, openedDocs: true }))
          void navigate(startHere ? docUrl('team', startHere.path) : '/docs')
        }}
      >
        {startHere ? 'Open it' : 'Open Docs'}
      </button>
    ),
  })

  const count = steps.filter((s) => s.done === true).length
  const finished = steps.every((s) => s.done === true)

  // Finished: it stays for this visit and is saved away, so it's gone the next time Today opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the last step ticks; the page ignores a repeat
  useEffect(() => {
    if (finished && !editing && !leaving.current) onFinished(tile)
  }, [finished, editing])

  return (
    <Card
      title="Getting started"
      icon="flag"
      testId="today-start"
      action={
        <span className="flex items-center gap-3">
          <span className="text-xs text-ink-faint tabular-nums" data-testid="today-start-count">
            {count} of {steps.length}
            <span className="sr-only"> steps done</span>
          </span>
          <button
            type="button"
            onClick={() => onChange(removeTile(layout, tile.id))}
            data-testid="today-start-hide"
            aria-label="Hide Getting started"
            className="text-xs text-ink-soft underline decoration-ash-strong underline-offset-2 hover:text-ink"
          >
            Hide
          </button>
        </span>
      }
    >
      {finished ? (
        <p className="text-sm text-ink-soft" data-testid="today-start-finished">
          <span className="font-medium text-ink">You’re set.</span> This tile won’t be here next
          time. You can bring it back from Settings.
        </p>
      ) : (
        <p className="text-sm text-ink-soft">
          A few things that make {product()} useful from day one.
        </p>
      )}
      <ul className="mt-3 flex flex-col divide-y divide-ash/70 border-t border-ash/70">
        {steps.map((s) => (
          <li
            key={s.id}
            data-testid="today-start-step"
            data-step={s.id}
            data-done={s.done === true ? 'true' : 'false'}
            className="flex items-center gap-3 py-2.5"
          >
            <span
              aria-hidden="true"
              className={`flex size-5 shrink-0 items-center justify-center rounded-full border ${
                s.done === true
                  ? 'border-moss bg-moss text-paper-raised'
                  : 'border-ash-strong text-transparent'
              }`}
            >
              <Icon name="check" className="size-3" />
            </span>
            <span className="min-w-0 flex-1">
              <span
                className={`block text-sm font-medium ${
                  s.done === true ? 'text-ink-faint line-through' : 'text-ink'
                }`}
              >
                {s.title}
                {s.done === true ? <span className="sr-only"> (done)</span> : null}
              </span>
              {s.done === true ? null : (
                <span className="block text-xs text-ink-soft">{s.hint}</span>
              )}
            </span>
            {s.done === false ? s.action : null}
          </li>
        ))}
      </ul>
      <MusicOffer />
      <BreaksOffer />
    </Card>
  )
}

/**
 * The background music offer (docs/PLAN-background-music.md M5): an extra line under the steps,
 * not a counted step, until it's answered in this browser.
 */
function MusicOffer() {
  const s = useMusic()
  if (s.asked || s.on) return null
  return (
    <div
      data-testid="today-start-music"
      className="mt-1 flex items-center gap-3 border-t border-ash/70 pt-2.5"
    >
      <span
        aria-hidden="true"
        className="flex size-5 shrink-0 items-center justify-center text-ink-faint"
      >
        <Icon name="music" className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink">Play calm music while you work?</span>
        <span className="block text-xs text-ink-soft">
          Soft piano, lo-fi, ambient or rain. Only you hear it, and you can change it any time.
        </span>
      </span>
      <button
        type="button"
        className="shrink-0 text-xs text-ink-soft underline decoration-ash-strong underline-offset-2 hover:text-ink"
        data-testid="today-start-music-no"
        onClick={() => music().decline()}
      >
        No thanks
      </button>
      <button
        type="button"
        className={stepButton}
        data-testid="today-start-music-on"
        onClick={() => music().play()}
      >
        Turn on
      </button>
    </div>
  )
}

/**
 * The screen breaks offer (docs/PLAN-breaks.md B12a): like the music one, an extra line under the
 * steps until it's answered. Either answer saves the member's settings, so it's asked once for
 * every device.
 */
function BreaksOffer() {
  const { settings, saved, loaded } = useBreakSettings()
  if (!loaded || saved || settings.on) return null
  return (
    <div
      data-testid="start-breaks-offer"
      className="mt-1 flex items-center gap-3 border-t border-ash/70 pt-2.5"
    >
      <span
        aria-hidden="true"
        className="flex size-5 shrink-0 items-center justify-center text-ink-faint"
      >
        <Icon name="eye" className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink">Take screen breaks?</span>
        <span className="block text-xs text-ink-soft">
          Every 20 minutes, a 20-second reminder to look away. Change it any time in Settings.
        </span>
      </span>
      <button
        type="button"
        className="shrink-0 text-xs text-ink-soft underline decoration-ash-strong underline-offset-2 hover:text-ink"
        data-testid="start-breaks-no"
        onClick={() => void saveBreakSettings({ on: false })}
      >
        No thanks
      </button>
      <button
        type="button"
        className={stepButton}
        data-testid="start-breaks-on"
        onClick={() => void saveBreakSettings({ on: true })}
      >
        Turn on
      </button>
    </div>
  )
}
