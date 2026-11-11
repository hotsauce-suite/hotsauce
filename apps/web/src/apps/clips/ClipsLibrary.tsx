import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { type Clip, clipsApi } from '../../api/clips'
import { product } from '../../brand/product'
import { Icon } from '../../components/Icon'
import { MeetingsPageHeader, primaryButton } from '../meetings/components/common'
import { formatDuration, formatWhen } from './format'

type Scope = 'mine' | 'team'

/** `/clips`: the member's clips, or everyone's, newest first, searchable. */
export default function ClipsLibrary() {
  const [params, setParams] = useSearchParams()
  const scope: Scope = params.get('scope') === 'team' ? 'team' : 'mine'
  const [query, setQuery] = useState(params.get('q') ?? '')
  const [clips, setClips] = useState<Clip[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    document.title = `${product()} Clips`
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick re-fetches while clips process.
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(
      () => {
        clipsApi.list(scope, query).then(
          (res) => {
            if (cancelled) return
            setClips(res.clips)
            setError(null)
          },
          (err: unknown) => {
            if (!cancelled) setError(err instanceof Error ? err.message : 'Couldn’t load clips')
          },
        )
      },
      query ? 200 : 0,
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [scope, query, tick])

  // A clip that's still processing gets its thumbnail in a few seconds; look again until then.
  const processing = clips?.some((c) => c.status === 'processing') ?? false
  useEffect(() => {
    if (!processing) return
    const timer = setInterval(() => setTick((n) => n + 1), 4000)
    return () => clearInterval(timer)
  }, [processing])

  const setScope = (next: Scope) => {
    const p = new URLSearchParams(params)
    if (next === 'team') p.set('scope', 'team')
    else p.delete('scope')
    setParams(p, { replace: true })
    setClips(null)
  }

  return (
    <>
      <MeetingsPageHeader title={`${product()} Clips`}>
        <Link to="/clips/new" className={`${primaryButton} h-9`} data-testid="record-clip">
          <span className="size-2 rounded-full bg-paper-raised" aria-hidden="true" />
          <span className="hidden sm:inline">Record a clip</span>
          <span className="sm:hidden">Record</span>
        </Link>
      </MeetingsPageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="clips-library">
        <div className="mx-auto w-full max-w-6xl px-4 pt-6 pb-24 md:px-8">
          <div className="flex flex-wrap items-center gap-3">
            <div role="tablist" aria-label="Whose clips" className="clips-tabs">
              {(['mine', 'team'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="tab"
                  aria-selected={scope === s}
                  data-testid={`clips-scope-${s}`}
                  onClick={() => setScope(s)}
                >
                  {s === 'mine' ? 'My clips' : 'Team'}
                </button>
              ))}
            </div>
            <label className="relative ml-auto w-full sm:w-72">
              <span className="sr-only">Search clips</span>
              <Icon
                name="search"
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-faint"
              />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search titles and transcripts"
                data-testid="clips-search"
                className="h-9 w-full rounded-lg border border-ash bg-paper-raised pr-3 pl-9 text-sm text-ink placeholder:text-ink-faint focus:border-ember focus:outline-none"
              />
            </label>
          </div>

          {error ? (
            <p role="alert" className="mt-6 text-sm text-ember">
              {error}
            </p>
          ) : null}

          {clips === null && !error ? (
            <div className="clips-grid mt-6" aria-hidden="true">
              {[0, 1, 2].map((n) => (
                <div key={n} className="clip-card clip-card--loading">
                  <div className="clip-thumb" />
                  <div className="h-4 w-2/3 rounded bg-paper-sunk" />
                </div>
              ))}
            </div>
          ) : null}

          {clips?.length === 0 ? <Empty searching={query.trim() !== ''} scope={scope} /> : null}

          {clips && clips.length > 0 ? (
            <ul className="clips-grid mt-6">
              {clips.map((clip) => (
                <li key={clip.id}>
                  <ClipCard clip={clip} showOwner={scope === 'team'} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </>
  )
}

function ClipCard({ clip, showOwner }: { clip: Clip; showOwner: boolean }) {
  return (
    <Link to={`/clips/${clip.id}`} className="clip-card group" data-testid="clip-card">
      <div className="clip-thumb">
        {clip.thumbUrl ? (
          <img src={clip.thumbUrl} alt="" loading="lazy" decoding="async" />
        ) : (
          <div className="clip-thumb__empty">
            {clip.status === 'processing' ? (
              <span className="clip-pulse">Processing…</span>
            ) : clip.status === 'failed' ? (
              <span className="text-ember">Couldn’t be processed</span>
            ) : (
              <Icon name="video" className="size-7" />
            )}
          </div>
        )}
        {clip.durationMs ? (
          <span className="clip-thumb__duration">{formatDuration(clip.durationMs)}</span>
        ) : null}
      </div>
      <div className="min-w-0 px-0.5">
        <p
          className="truncate font-medium text-ink group-hover:text-ember"
          data-testid="clip-card-title"
        >
          {clip.title}
        </p>
        <p className="mt-0.5 truncate text-xs text-ink-faint">
          {showOwner ? `${clip.owner.name} · ` : ''}
          {formatWhen(clip.createdAt)}
        </p>
      </div>
    </Link>
  )
}

function Empty({ searching, scope }: { searching: boolean; scope: Scope }) {
  if (searching) {
    return <p className="mt-16 text-center text-sm text-ink-faint">No clips match that search.</p>
  }
  return (
    <div className="clips-empty mt-12">
      <div className="clips-empty__art" aria-hidden="true">
        <div className="clips-empty__screen" />
        <div className="clips-empty__bubble" />
      </div>
      <h2 className="font-display text-2xl font-semibold tracking-tight text-ink">
        {scope === 'mine' ? 'Show it instead of typing it' : 'No team clips yet'}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">
        Record your screen with your face in the corner, send the link, and whoever watches gets a
        transcript and can play it at double speed.
      </p>
      <Link to="/clips/new" className={`${primaryButton} mt-6`}>
        <span className="size-2 rounded-full bg-paper-raised" aria-hidden="true" />
        Record a clip
      </Link>
    </div>
  )
}
