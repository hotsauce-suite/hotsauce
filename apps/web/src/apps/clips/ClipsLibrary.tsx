import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { type Clip, clipsApi } from '../../api/clips'
import { product } from '../../brand/product'
import { EmptyState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { ListBar, ListColumn, scopeTabs, useScope } from '../../components/ListBar'
import { LoadError } from '../../components/LoadError'
import { MainButton } from '../../components/PageHeader'
import { MeetingsPageHeader, primaryButton } from '../meetings/components/common'
import { formatDuration, formatWhen } from './format'

type Scope = 'mine' | 'team'

/** `/clips`: the member's clips, or everyone's, newest first, searchable. */
export default function ClipsLibrary() {
  const [params] = useSearchParams()
  const [scope, chooseScope] = useScope(['mine', 'team'])
  const [query, setQuery] = useState(params.get('q') ?? '')
  const [clips, setClips] = useState<Clip[] | null>(null)
  const [failed, setFailed] = useState(false)
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
            setFailed(false)
          },
          () => {
            if (!cancelled) setFailed(true)
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
    chooseScope(next)
    setClips(null)
  }

  return (
    <>
      <MeetingsPageHeader title="Clips">
        <MainButton
          to="/clips/new"
          testId="record-clip"
          lead={<span className="size-2 rounded-full bg-paper-raised" aria-hidden="true" />}
        >
          Record a clip
        </MainButton>
      </MeetingsPageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="clips-library">
        <ListColumn width="gallery">
          <ListBar
            tabs={scopeTabs(['mine', 'team'], 'clips')}
            tab={scope}
            onTab={setScope}
            tabsLabel="Whose clips"
            search={{
              value: query,
              onChange: setQuery,
              label: 'Search clips',
              placeholder: 'Search titles and transcripts',
              testId: 'clips-search',
            }}
            className=""
          />

          {failed ? (
            <LoadError things="clips" onRetry={() => setTick((n) => n + 1)} className="mt-6" />
          ) : null}

          {clips === null && !failed ? (
            <div className="clips-grid mt-6" aria-hidden="true">
              {[0, 1, 2].map((n) => (
                <div key={n} className="clip-card clip-card--loading">
                  <div className="clip-thumb" />
                  <div className="h-4 w-2/3 rounded bg-paper-sunk" />
                </div>
              ))}
            </div>
          ) : null}

          {!failed && clips?.length === 0 ? (
            <Empty searching={query.trim() !== ''} scope={scope} />
          ) : null}

          {clips && clips.length > 0 ? (
            <ul className="clips-grid mt-6">
              {clips.map((clip) => (
                <li key={clip.id}>
                  <ClipCard clip={clip} showOwner={scope === 'team'} />
                </li>
              ))}
            </ul>
          ) : null}
        </ListColumn>
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
    return (
      <EmptyState icon="video" title="No clips match that" className="mt-4">
        Search looks at clip titles and what was said in them.
      </EmptyState>
    )
  }
  return (
    <EmptyState
      icon="video"
      className="mt-4"
      title={scope === 'mine' ? 'No clips yet' : 'No team clips yet'}
      action={
        <Link to="/clips/new" className={primaryButton}>
          <span className="size-2 rounded-full bg-paper-raised" aria-hidden="true" />
          Record a clip
        </Link>
      }
    >
      Record your screen with your face in the corner, send the link, and whoever watches gets a
      transcript and can play it at double speed.
    </EmptyState>
  )
}
