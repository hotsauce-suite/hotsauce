import { defaultTodayLayout, type TodayLayout } from '@hearth/format'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { HearthApiError } from '../../api/client'
import { dictationApi } from '../../api/dictation'
import type { TaskView } from '../../api/tasks'
import { type TodayView, todayApi } from '../../api/today'
import { hearthSocket } from '../../api/ws'
import { product } from '../../brand/product'
import { Icon } from '../../components/Icon'
import { MAC_APP_SETTINGS, useMacAppBuild } from '../../components/MacApp'
import { TOUCH_QUERY, useMediaQuery } from '../../hooks/useMediaQuery'
import { desktopSignInBridge } from '../../lib/desktop'
import { useSession } from '../../state/session'
import { MeetingsPageHeader } from '../meetings/components/common'
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
  const [error, setError] = useState<string | null>(null)
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
      setError(null)
    } catch (err) {
      if (ask !== latest.current) return
      setError(err instanceof HearthApiError ? err.message : 'Today didn’t load.')
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
    const offChanged = hearthSocket.onChanged(soon)
    const offReconnect = hearthSocket.onReconnect(soon)
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
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="today">
        <div className="mx-auto w-full max-w-6xl px-4 pt-6 pb-24 md:px-8">
          <div className="mb-5 flex flex-wrap items-start gap-3">
            <TodayGreeting view={view} name={session.me?.principal.name} now={now} />
            <EditBar {...layouts} />
          </div>
          {error ? (
            <p role="alert" className="mb-4 text-sm text-ember-strong">
              {error}
            </p>
          ) : null}
          {layouts.error ? (
            <p
              role="alert"
              className="mb-4 text-sm text-ember-strong"
              data-testid="today-layout-error"
            >
              {layouts.error}
            </p>
          ) : null}
          {view === null ? (
            error ? null : (
              <p className="text-sm text-ink-faint" data-testid="today-loading">
                Loading your day…
              </p>
            )
          ) : (
            <TodayTiles
              layout={layouts.shown}
              view={view}
              now={now}
              editing={layouts.draft !== null}
              onChange={layouts.change}
              onTaskDone={removeTask}
              onTaskAdded={addTask}
            />
          )}
          <div className="mt-5 lg:ml-auto lg:w-2/5">
            <MacAppCard />
          </div>
        </div>
      </div>
    </>
  )
}

/** The member's saved layout, and the draft while they edit it (plan E1–E3). */
function useLayout() {
  const [layout, setLayout] = useState<TodayLayout>(defaultTodayLayout)
  const [draft, setDraft] = useState<TodayLayout | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    todayApi.layout().then(
      (r) => {
        if (!cancelled) setLayout(r.layout)
      },
      // The default layout stands in.
      () => undefined,
    )
    return () => {
      cancelled = true
    }
  }, [])

  const save = async (next: TodayLayout): Promise<boolean> => {
    setSaving(true)
    setError(null)
    try {
      setLayout((await todayApi.saveLayout(next)).layout)
      return true
    } catch (err) {
      setError(
        err instanceof HearthApiError
          ? `Your Today layout didn’t save: ${err.message}`
          : 'Your Today layout didn’t save. Try again.',
      )
      return false
    } finally {
      setSaving(false)
    }
  }

  return {
    shown: draft ?? layout,
    draft,
    saving,
    error,
    edit: () => {
      setError(null)
      setDraft(layout)
    },
    cancel: () => {
      setError(null)
      setDraft(null)
    },
    reset: () => setDraft(defaultTodayLayout()),
    done: async () => {
      if (draft && (await save(draft))) setDraft(null)
    },
    /** In edit mode it changes the draft; outside it (a Board tile's pick) it saves at once. */
    change: (next: TodayLayout) => {
      if (draft) setDraft(next)
      else {
        setLayout(next)
        void save(next)
      }
    },
  }
}

function EditBar(l: ReturnType<typeof useLayout>) {
  if (!l.draft)
    return (
      <button type="button" onClick={l.edit} className={toolButton} data-testid="today-edit">
        <Icon name="pencil" className="mr-1.5 size-4" />
        Edit Today
      </button>
    )
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="today-edit-bar">
      <AddTileMenu layout={l.draft} onChange={l.change} />
      <button
        type="button"
        onClick={l.reset}
        className="px-2 text-sm text-ink-soft underline hover:text-ink"
        data-testid="today-reset"
      >
        Reset to default
      </button>
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
