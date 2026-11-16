import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { type BriefcastOverview, briefcastApi, type Episode } from '../../api/briefcast'
import { HotsauceApiError } from '../../api/client'
import { product } from '../../brand/product'
import { Icon } from '../../components/Icon'
import { readingColumn } from '../../components/ItemColumn'
import { LoadError } from '../../components/LoadError'
import { NEEDS_CONNECTION } from '../../components/Offline'
import { MainButton } from '../../components/PageHeader'
import { useOnline } from '../../lib/connection'
import { loadSpeed, SPEEDS, saveSpeed, speedLabel } from '../clips/speed'
import { MeetingsPageHeader, primaryButton, secondaryButton } from '../meetings/components/common'

type Load =
  | { status: 'loading' }
  | { status: 'error'; message: string | null }
  | { status: 'ready'; overview: BriefcastOverview; episode: Episode | null }

/** `/briefcast` and `/briefcast/:date`: the member's morning briefing, its script and the feed. */
export default function BriefcastPage() {
  const { date } = useParams()
  const navigate = useNavigate()
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const [making, setMaking] = useState(false)
  const online = useOnline()
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry trigger.
  useEffect(() => {
    document.title = `Briefcast · ${product()}`
    let cancelled = false
    setLoad({ status: 'loading' })
    briefcastApi
      .get()
      .then(async (overview) => {
        const episode =
          date && date !== overview.latest?.date
            ? await briefcastApi.episode(date)
            : overview.latest
        if (!cancelled) setLoad({ status: 'ready', overview, episode })
      })
      .catch((err: unknown) => {
        // A day with no episode has its own answer; anything else is "couldn't load".
        const missing = err instanceof HotsauceApiError && err.status === 404
        if (!cancelled) setLoad({ status: 'error', message: missing ? err.message : null })
      })
    return () => {
      cancelled = true
    }
  }, [date, attempt])

  const make = async () => {
    setMaking(true)
    setMessage(null)
    setError(null)
    try {
      const res = await briefcastApi.refresh()
      if (res.status === 'empty') {
        setMessage(
          'Nothing to brief you on yet: no meetings today, nothing recent, no tasks due and no changed docs.',
        )
        return
      }
      const overview = await briefcastApi.get()
      setLoad({ status: 'ready', overview, episode: res.episode ?? overview.latest })
      if (date) navigate('/briefcast')
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setMaking(false)
    }
  }

  return (
    <>
      <MeetingsPageHeader
        // A past episode is named once, in the top bar (docs/PLAN-consistency.md, requirement 27).
        title={
          date ? (
            <span className="truncate" data-testid="briefcast-title">
              {load.status === 'ready' && load.episode ? load.episode.title : 'Past briefing'}
            </span>
          ) : (
            'Briefcast'
          )
        }
        {...(date ? { back: { to: '/briefcast', label: 'Briefcast' } } : {})}
      >
        <MainButton
          icon="sparkle"
          onClick={make}
          disabled={making || load.status === 'loading' || !online}
          {...(online ? {} : { title: NEEDS_CONNECTION })}
          testId="briefcast-make"
        >
          {making ? 'Making your briefing…' : 'Make today’s briefing'}
        </MainButton>
      </MeetingsPageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="briefcast-page">
        <div data-item-width="reading" className={`${readingColumn} pt-6 pb-24`}>
          {message ? (
            <p className="mb-4 text-sm text-ink-soft" data-testid="briefcast-message">
              {message}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="mb-4 text-sm text-ember" data-testid="briefcast-error">
              {error}
            </p>
          ) : null}
          {load.status === 'loading' ? (
            <div className="h-40 animate-pulse rounded-xl bg-paper-sunk" aria-hidden="true" />
          ) : load.status === 'error' && load.message ? (
            <p role="alert" className="text-sm text-ink-soft" data-testid="briefcast-missing">
              {load.message}
            </p>
          ) : load.status === 'error' ? (
            <LoadError things="briefcast" onRetry={() => setAttempt((n) => n + 1)} />
          ) : (
            <>
              {load.episode ? (
                <EpisodeView episode={load.episode} voice={load.overview.voice} named={!date} />
              ) : (
                <Empty hour={load.overview.readyHour} />
              )}
              <PastEpisodes overview={load.overview} current={load.episode?.date ?? null} />
              <Feed
                url={load.overview.feedUrl}
                onChange={(feedUrl) =>
                  setLoad((l) =>
                    l.status === 'ready' ? { ...l, overview: { ...l.overview, feedUrl } } : l,
                  )
                }
              />
            </>
          )}
        </div>
      </div>
    </>
  )
}

function Empty({ hour }: { hour: number }) {
  return (
    <section
      className="rounded-xl border border-ash bg-paper-raised p-6"
      data-testid="briefcast-empty"
    >
      <h2 className="font-display text-xl font-semibold tracking-tight text-ink">
        Your morning briefing
      </h2>
      <p className="mt-2 text-sm text-ink-soft">
        Every weekday by {hour} AM, Briefcast reads you a five-minute rundown of your day: your
        meetings with a line of prep for each, what changed yesterday, what’s due, and anything that
        looks stuck. Your first one arrives tomorrow morning, or make one now.
      </p>
    </section>
  )
}

function EpisodeView({
  episode,
  voice,
  named,
}: {
  episode: Episode
  voice: boolean
  /** Today's episode shows its name here; a past one has it in the top bar. */
  named: boolean
}) {
  const made = episode.generated ? new Date(episode.generated) : null
  const sources = [
    plural(episode.counts.events, 'meeting today', 'meetings today'),
    plural(episode.counts.meetings, 'recent meeting', 'recent meetings'),
    plural(episode.counts.tasks, 'task', 'tasks'),
    plural(episode.counts.docs, 'changed doc', 'changed docs'),
    plural(episode.counts.links ?? 0, 'saved link', 'saved links'),
  ].filter(Boolean)
  return (
    <section
      className="rounded-xl border border-ash bg-paper-raised p-5 md:p-6"
      data-testid="briefcast-episode"
    >
      {named ? (
        <h2 className="mb-1 font-display text-2xl font-semibold tracking-tight text-ink">
          {episode.title}
        </h2>
      ) : null}
      <p className="text-xs text-ink-faint" data-testid="briefcast-made">
        {made
          ? `Made ${made.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`
          : ''}
        {sources.length > 0 ? ` from ${sources.join(', ')}` : ''}
        {episode.seconds ? ` · ${duration(episode.seconds)}` : ''}
      </p>
      {episode.audio ? (
        <Player
          key={`${episode.date} ${episode.generated}`}
          date={episode.date}
          version={episode.generated}
        />
      ) : (
        <p
          className="mt-4 rounded-lg bg-paper-sunk px-3 py-2 text-sm text-ink-soft"
          data-testid="briefcast-no-audio"
        >
          {episode.audioExpired
            ? 'This episode’s audio was deleted after 30 days. The script is below.'
            : voice
              ? 'The voice didn’t come through for this one. Make today’s briefing again to retry.'
              : 'Audio isn’t set up yet, so here is the script to read.'}
        </p>
      )}
      <div
        className="mt-5 space-y-3 text-[15px] leading-relaxed text-ink"
        data-testid="briefcast-script"
      >
        {episode.script.split(/\n\s*\n/).map((para, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs have no identity of their own
          <p key={i}>{para}</p>
        ))}
      </div>
    </section>
  )
}

function Player({ date, version }: { date: string; version: string }) {
  const audio = useRef<HTMLAudioElement>(null)
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [speed, setSpeed] = useState(loadSpeed)

  useEffect(() => {
    let url: string | null = null
    let cancelled = false
    setSrc(null)
    setFailed(null)
    briefcastApi.audio(date, version).then(
      (blob) => {
        if (cancelled) return
        url = URL.createObjectURL(blob)
        setSrc(url)
      },
      (err: unknown) => {
        if (!cancelled) setFailed(messageOf(err))
      },
    )
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [date, version])

  useEffect(() => {
    if (audio.current) audio.current.playbackRate = speed
  }, [speed])

  if (failed) {
    return (
      <p role="alert" className="mt-4 text-sm text-ember">
        {failed}
      </p>
    )
  }
  return (
    <div className="mt-4 flex flex-col gap-3">
      {/* biome-ignore lint/a11y/useMediaCaption: the script below is the transcript */}
      <audio
        ref={audio}
        controls
        preload="auto"
        src={src ?? undefined}
        className="w-full"
        data-testid="briefcast-audio"
        onLoadedMetadata={() => {
          if (audio.current) audio.current.playbackRate = speed
        }}
      />
      <fieldset className="flex flex-wrap items-center gap-1.5" aria-label="Playback speed">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={s === speed}
            onClick={() => {
              setSpeed(s)
              saveSpeed(s)
            }}
            className={`h-7 rounded-md px-2 text-xs ${
              s === speed
                ? 'bg-ember text-paper-raised'
                : 'border border-ash text-ink-soft hover:border-ember'
            }`}
          >
            {speedLabel(s)}
          </button>
        ))}
      </fieldset>
    </div>
  )
}

function PastEpisodes({
  overview,
  current,
}: {
  overview: BriefcastOverview
  current: string | null
}) {
  const past = overview.episodes.filter((e) => e.date !== current)
  if (past.length === 0) return null
  return (
    <section className="mt-8" data-testid="briefcast-past">
      <h2 className="text-sm font-medium text-ink-soft">Past briefings</h2>
      <ul className="mt-2 divide-y divide-ash/70 rounded-xl border border-ash bg-paper-raised">
        {past.map((e) => (
          <li key={e.date}>
            <Link
              to={`/briefcast/${e.date}`}
              className="flex items-center gap-3 px-4 py-2.5 text-sm text-ink hover:text-ember"
            >
              <Icon name="headphones" className="size-4 text-ink-faint" />
              <span className="min-w-0 flex-1 truncate">{e.title}</span>
              <span className="text-xs text-ink-faint">
                {e.audio ? (e.seconds ? duration(e.seconds) : 'Audio') : 'Script'}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Feed({ url, onChange }: { url: string | null; onChange: (url: string | null) => void }) {
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (action: () => Promise<string | null>) => {
    setBusy(true)
    setError(null)
    setCopied(false)
    try {
      onChange(await action())
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }
  const make = () => run(async () => (await briefcastApi.makeFeed()).feedUrl)
  const off = () =>
    run(async () => {
      await briefcastApi.removeFeed()
      return null
    })
  const copy = async () => {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      setError('Couldn’t copy. Select the link and copy it.')
    }
  }
  const bare = url?.replace(/^https?:\/\//, '') ?? ''
  return (
    <section
      className="mt-8 rounded-xl border border-ash bg-paper-raised p-5"
      data-testid="briefcast-feed"
    >
      <h2 className="font-medium text-ink">Listen in your podcast app</h2>
      <p className="mt-1 text-sm text-ink-soft">
        A private feed only you can use: add it once and each morning’s briefing downloads on its
        own. Anyone with the link can listen, so keep it to yourself; making a new link turns the
        old one off.
      </p>
      {url ? (
        <>
          <div className="mt-3 flex gap-2">
            <input
              readOnly
              value={url}
              aria-label="Your private feed link"
              data-testid="briefcast-feed-url"
              onFocus={(e) => e.currentTarget.select()}
              className="h-9 min-w-0 flex-1 rounded-lg border border-ash bg-paper px-3 text-xs text-ink"
            />
            <button type="button" className={`${secondaryButton} h-9`} onClick={copy}>
              <Icon name="copy" className="size-4" />
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <a className={`${secondaryButton} h-9`} href={`podcast://${bare}`}>
              Open in Apple Podcasts
            </a>
            <a
              className={`${secondaryButton} h-9`}
              href={`overcast://x-callback-url/add?url=${encodeURIComponent(url)}`}
            >
              Open in Overcast
            </a>
            <button
              type="button"
              className={`${secondaryButton} h-9`}
              onClick={make}
              disabled={busy}
            >
              Make a new link
            </button>
            <button
              type="button"
              className={`${secondaryButton} h-9`}
              onClick={off}
              disabled={busy}
            >
              Turn off
            </button>
          </div>
        </>
      ) : (
        <button
          type="button"
          className={`${primaryButton} mt-3 h-9`}
          onClick={make}
          disabled={busy}
          data-testid="briefcast-feed-make"
        >
          Get my private feed link
        </button>
      )}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-ember">
          {error}
        </p>
      ) : null}
    </section>
  )
}

function plural(n: number, one: string, many: string): string {
  return n === 0 ? '' : `${n} ${n === 1 ? one : many}`
}

function duration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong'
}
