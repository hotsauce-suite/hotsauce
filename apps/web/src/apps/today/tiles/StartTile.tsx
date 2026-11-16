// The Getting started tile (docs/PLAN-getting-started.md): a new member's first few steps, at the
// top of Today until they're done or hidden. Each step is ticked from what is really so, not from
// a click, except "see the docs", which nothing else can show.

import { removeTile, type TodayLayout, type TodayTile, updateTile } from '@hotsauce/format'
import { type ReactNode, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { dictationApi } from '../../../api/dictation'
import type { TodayView } from '../../../api/today'
import { product } from '../../../brand/product'
import { Icon } from '../../../components/Icon'
import { MAC_APP_SETTINGS, useMacAppBuild } from '../../../components/MacApp'
import { TOUCH_QUERY, useMediaQuery } from '../../../hooks/useMediaQuery'
import { desktopSignInBridge } from '../../../lib/desktop'
import { installContext } from '../../../lib/install'
import { Card } from './Card'

const CALENDARS = '/settings/connections#calendars'
const APPS = '/settings/apps'

interface Step {
  id: 'calendar' | 'mac' | 'home' | 'docs'
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
  steps.push({
    id: 'docs',
    title: 'See where the team’s work lives',
    hint: 'Shared docs, grouped by space.',
    done: tile.openedDocs === true,
    action: (
      <button
        type="button"
        className={stepButton}
        data-testid="today-start-docs"
        onClick={() => {
          onChange(updateTile(layout, { ...tile, openedDocs: true }))
          void navigate('/docs')
        }}
      >
        Open Docs
      </button>
    ),
  })

  const count = steps.filter((s) => s.done === true).length
  const finished = steps.every((s) => s.done === true)

  // Finished: it stays for this visit and is saved away, so it's gone the next time Today opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the last step ticks; the page ignores a repeat
  useEffect(() => {
    if (finished && !editing) onFinished(tile)
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
    </Card>
  )
}
