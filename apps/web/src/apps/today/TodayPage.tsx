import {
  defaultTodayLayout,
  layoutTiles,
  offerForYou,
  removeTile,
  showGettingStarted,
  type TodayLayout,
  type TodayTile,
} from '@hotsauce/format'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { HotsauceApiError } from '../../api/client'
import { dictationApi } from '../../api/dictation'
import type { TaskView } from '../../api/tasks'
import { type TodayView, todayApi } from '../../api/today'
import { hotsauceSocket } from '../../api/ws'
import { product } from '../../brand/product'
import { Icon } from '../../components/Icon'
import { LoadError } from '../../components/LoadError'
import { MAC_APP_SETTINGS, useMacAppBuild } from '../../components/MacApp'
import { TOUCH_QUERY, useMediaQuery } from '../../hooks/useMediaQuery'
import { desktopSignInBridge } from '../../lib/desktop'
import { useSession } from '../../state/session'
import { TourHost } from '../../tour/TourHost'
import { MeetingsPageHeader } from '../meetings/components/common'
import { SkyScenePicker } from './sky/SkyScenePicker'
import { TodaySky } from './sky/TodaySky'
import { TodayClock, TodayGreeting, useMinuteClock } from './TodayHeader'
import { AddTileMenu, TodayTiles } from './TodayTiles'
import { Card } from './tiles/Card'

/** Changes from elsewhere (a task done on the phone, a doc saved) refresh Today this soon. */
const REFRESH_DEBOUNCE_MS = 500
/** Today also refreshes on its own, so "In 5 min" and the calendar stay current. */
const REFRESH_EVERY_MS = 60_000

const toolButton =
  'inline-flex h-9 items-center rounded-lg border border-ash-strong px-3 text-sm text-ink hover:border-ember disabled:opacity-50'

/** `/today`: the home page. The member's day on one screen, nothing written by AI. */
export default function TodayPage() {
  const session = useSession()
  const [view, setView] = useState<TodayView | null>(null)
  const [failed, setFailed] = useState(false)
  const clock = useMinuteClock()
  const [loadedAt, setLoadedAt] = useState(() => new Date())
  // Whichever is newer: the minute clock or the last load.
  const now = clock > loadedAt ? clock : loadedAt

  // Only the newest request's answer is shown: an older one finishing late would bring back a
  // task completed in between.
  const latest = useRef(0)
  const load = useCallback(async () => {
    const ask = ++latest.current
    try {
      const next = await todayApi.get()
      if (ask !== latest.current) return
      setView(next)
      setFailed(false)
    } catch {
      if (ask !== latest.current) return
      setFailed(true)
    } finally {
      setLoadedAt(new Date())
    }
  }, [])

  useEffect(() => {
    document.title = `${product()} Today`
    void load()
    let timer: ReturnType<typeof setTimeout> | null = null
    const soon = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void load(), REFRESH_DEBOUNCE_MS)
    }
    const offChanged = hotsauceSocket.onChanged(soon)
    const offReconnect = hotsauceSocket.onReconnect(soon)
    const every = setInterval(() => void load(), REFRESH_EVERY_MS)
    return () => {
      offChanged()
      offReconnect()
      clearInterval(every)
      if (timer) clearTimeout(timer)
    }
  }, [load])

  // Whatever is in flight was asked before these changes: its answer is dropped.
  const removeTask = (task: TaskView) => {
    latest.current++
    setView((v) => (v ? { ...v, tasks: v.tasks.filter((t) => t.id !== task.id) } : v))
  }
  const addTask = (task: TaskView) => {
    latest.current++
    setView((v) => (v ? { ...v, tasks: [...v.tasks, task] } : v))
  }

  const layouts = useLayout()

  return (
    <>
      <MeetingsPageHeader title="Today" menu={false}>
        <TodayClock />
      </MeetingsPageHeader>
      <div
        // While editing, the pinned bar mustn't hide whatever has keyboard focus.
        className={`min-h-0 flex-1 overflow-y-auto ${layouts.draft ? 'scroll-pt-20' : ''}`}
        data-testid="today"
        data-today-scroller
      >
        <div className="mx-auto w-full max-w-6xl px-4 pt-6 pb-24 md:px-8">
          {layouts.draft ? <EditBar {...layouts} /> : null}
          <div className="mb-5 flex flex-wrap items-start gap-3">
            <TodaySky now={now}>
              <TodayGreeting view={view} name={session.me?.principal.name} now={now} />
            </TodaySky>
          </div>
          {failed ? <LoadError things="day" onRetry={() => void load()} className="mb-4" /> : null}
          {layouts.error ? (
            <p
              role="alert"
              className="mb-4 text-sm text-ember-strong"
              data-testid="today-layout-error"
            >
              {layouts.error}
            </p>
          ) : null}
          <TourHost ready={view !== null && layouts.shown !== null && layouts.draft === null} />
          {view === null || layouts.shown === null ? (
            failed ? null : (
              <p className="text-sm text-ink-faint" data-testid="today-loading">
                Loading your day…
              </p>
            )
          ) : (
            <TodayTiles
              layout={layouts.shown}
              view={view}
              now={now}
              refresh={loadedAt.getTime()}
              editing={layouts.draft !== null}
              onChange={layouts.change}
              onStartFinished={layouts.finish}
              onTaskDone={removeTask}
              onTaskAdded={addTask}
            />
          )}
          {/* Getting started already offers the Mac app: not twice on one page. */}
          {view && layouts.shown && !layoutTiles(layouts.shown).some((t) => t.kind === 'start') ? (
            <div className="mt-5 lg:ml-auto lg:w-2/5">
              <MacAppCard />
            </div>
          ) : null}
          {/* At the bottom, small: arranging Today is occasional, so it stays out of the way. */}
          {view && layouts.shown && !layouts.draft ? <EditBar {...layouts} /> : null}
        </div>
      </div>
    </>
  )
}

/** The member's saved layout, and the draft while they edit it (plan E1–E3). */
function useLayout() {
  // Null until the saved layout arrives: editing a stand-in would save over the real one.
  const [layout, setLayout] = useState<TodayLayout | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [draft, setDraft] = useState<TodayLayout | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    todayApi.layout().then(
      (r) => {
        if (!cancelled) setLayout(r.layout)
      },
      () => {
        // The default stands in for this visit, read-only.
        if (!cancelled) setLoadFailed(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  // Saves go out one at a time, in the order they were made, and only the newest one's answer is
  // shown: an older answer landing late would put back what a newer change replaced.
  const newest = useRef(0)
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const save = (next: TodayLayout): Promise<boolean> => {
    const mine = ++newest.current
    setSaving(true)
    setError(null)
    const run = queue.current.then(async () => {
      try {
        const saved = (await todayApi.saveLayout(next)).layout
        if (mine === newest.current) setLayout(saved)
        return true
      } catch (err) {
        if (mine === newest.current)
          setError(
            err instanceof HotsauceApiError
              ? `Your Today layout didn’t save: ${err.message}`
              : 'Your Today layout didn’t save. Try again.',
          )
        return false
      } finally {
        if (mine === newest.current) setSaving(false)
      }
    })
    queue.current = run
    return run
  }

  // Settings' "Getting started" link opens `/today?start=1`: put the tile back, fresh, and save.
  const [params, setParams] = useSearchParams()
  const replay = params.get('start') === '1'
  // biome-ignore lint/correctness/useExhaustiveDependencies: `save` and `setParams` are new each render; this runs once per replay, when the saved layout is in
  useEffect(() => {
    if (!replay || !layout) return
    const next = showGettingStarted(layout)
    if (next !== layout) {
      setLayout(next)
      void save(next)
    }
    setParams(
      (p) => {
        p.delete('start')
        return p
      },
      { replace: true },
    )
  }, [replay, layout !== null])

  // A finished Getting started tile: already saved away, but kept on screen for this visit.
  const [lingering, setLingering] = useState<TodayTile | null>(null)
  const saved = layout ?? (loadFailed ? offerForYou(defaultTodayLayout()) : null)
  const current: TodayLayout | null =
    saved && lingering
      ? { schema: 1, columns: [[lingering, ...saved.columns[0]], saved.columns[1]] }
      : saved
  return {
    shown: draft ?? current,
    draft,
    saving,
    error:
      error ??
      (loadFailed ? 'Your Today layout didn’t load, so you’re seeing the default for now.' : null),
    /** Editing waits for the saved layout. */
    canEdit: layout !== null,
    edit: () => {
      if (!layout) return
      setError(null)
      setDraft(layout)
    },
    cancel: () => {
      setError(null)
      setDraft(null)
    },
    reset: () => setDraft(offerForYou(defaultTodayLayout())),
    done: async () => {
      if (draft && (await save(draft))) setDraft(null)
    },
    /** In edit mode it changes the draft; outside it (a Board tile's pick) it saves at once. */
    change: (next: TodayLayout) => {
      if (draft) setDraft(next)
      else if (layout) {
        // The lingering tile is only on screen: it never goes back into what is saved.
        const real = lingering ? removeTile(next, lingering.id) : next
        if (lingering && !layoutTiles(next).some((t) => t.id === lingering.id)) setLingering(null)
        setLayout(real)
        void save(real)
      }
    },
    /**
     * Getting started is finished: save the layout without it, through the same path as every
     * other save, and keep the tile on screen until the page is left.
     */
    finish: (tile: TodayTile) => {
      if (draft || !layout || lingering) return
      if (!layoutTiles(layout).some((t) => t.id === tile.id)) return
      const without = removeTile(layout, tile.id)
      setLingering(tile)
      setLayout(without)
      void save(without)
    },
  }
}

function EditBar(l: ReturnType<typeof useLayout>) {
  if (!l.draft)
    return (
      <div className="mt-6 flex justify-center">
        <button
          type="button"
          onClick={l.edit}
          disabled={!l.canEdit}
          className="inline-flex h-7 items-center rounded-md px-2 text-xs text-ink-faint hover:bg-paper-sunk hover:text-ink disabled:opacity-50"
          data-testid="today-edit"
        >
          <Icon name="pencil" className="mr-1 size-3.5" />
          Edit Today
        </button>
      </div>
    )
  // Pinned to the top of the screen while tiles are moved, wherever the page is scrolled to.
  return (
    <div
      className="sticky top-0 z-10 -mx-4 -mt-6 mb-5 flex items-center gap-1.5 sm:gap-2 border-b border-ash bg-paper px-4 py-3 md:-mx-8 md:px-8"
      data-testid="today-edit-bar"
    >
      <AddTileMenu layout={l.draft} onChange={l.change} />
      <SkyScenePicker />
      <button
        type="button"
        onClick={l.reset}
        className="px-2 text-sm text-ink-soft underline hover:text-ink"
        data-testid="today-reset"
      >
        <span className="sm:hidden">Reset</span>
        <span className="hidden sm:inline">Reset to default</span>
      </button>
      <span className="flex-1" />
      <button type="button" onClick={l.cancel} className={toolButton} data-testid="today-cancel">
        Cancel
      </button>
      <button
        type="button"
        onClick={() => void l.done()}
        disabled={l.saving}
        aria-busy={l.saving}
        className="inline-flex h-9 items-center rounded-lg bg-ember px-4 text-sm font-medium text-paper-raised hover:bg-ember-strong disabled:opacity-50"
        data-testid="today-done"
      >
        {l.saving ? 'Saving…' : 'Done'}
      </button>
    </div>
  )
}

/** This browser remembers that the member closed the Mac app card. */
export const MAC_APP_CARD_DISMISSED = 'hearth.today.macAppCard.dismissed'

function cardDismissed(): boolean {
  try {
    return localStorage.getItem(MAC_APP_CARD_DISMISSED) === '1'
  } catch {
    return false
  }
}

/**
 * "Get the Mac app", until the member has it: not inside the app's own window, not on a phone or
 * tablet, not on a server with no build, not once a Mac is connected, not once closed.
 */
function MacAppCard() {
  const touch = useMediaQuery(TOUCH_QUERY)
  const inApp = desktopSignInBridge() !== null
  const [dismissed, setDismissed] = useState(cardDismissed)
  const relevant = !touch && !inApp && !dismissed
  const hasBuild = useMacAppBuild(relevant)
  const [hasMac, setHasMac] = useState<boolean | null>(null)

  useEffect(() => {
    if (!relevant) return
    let cancelled = false
    dictationApi.devices().then(
      (devices) => {
        if (!cancelled) setHasMac(devices.length > 0)
      },
      // Not knowing is no reason to nag.
      () => {
        if (!cancelled) setHasMac(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [relevant])

  if (!relevant || hasBuild !== true || hasMac !== false) return null
  const dismiss = () => {
    try {
      localStorage.setItem(MAC_APP_CARD_DISMISSED, '1')
    } catch {
      // Hidden for this visit only.
    }
    setDismissed(true)
  }
  return (
    <Card
      title="Get the Mac app"
      icon="download"
      testId="today-mac-app"
      action={
        <button
          type="button"
          onClick={dismiss}
          aria-label="Hide the Mac app card"
          data-testid="today-mac-app-dismiss"
          className="rounded-md p-1 text-ink-faint hover:bg-paper-sunk hover:text-ink"
        >
          <Icon name="close" className="size-3.5" />
        </button>
      }
    >
      <p className="text-sm text-ink-soft">
        Dictate into any app, record any call and get a nudge before each meeting.{' '}
        <Link
          to={MAC_APP_SETTINGS}
          data-testid="today-mac-app-link"
          className="text-ember-strong underline"
        >
          Download it
        </Link>
      </p>
    </Card>
  )
}
