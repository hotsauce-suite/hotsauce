import { type DragEvent, type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import {
  type HighlightView,
  highlightLabel,
  type LinkView,
  linkKindLabel,
  linksApi,
  READ_TO_END,
  readingTime,
  readProgress,
  webUrl,
} from '../../api/links'
import { product } from '../../brand/product'
import { EmptyState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { ListBar, ListColumn } from '../../components/ListBar'
import { LoadError } from '../../components/LoadError'
import { MainButton, PageHeader } from '../../components/PageHeader'
import { focusedRow, holdListPlace, useListKeys } from '../../keyboard/listKeys'
import { useShortcut } from '../../keyboard/shortcuts'
import { inputClass } from '../../routes/org/fields'
import { useSession } from '../../state/session'
import { secondaryButton } from '../meetings/components/common'
import { addPdf, pdfProblem } from './pdfUpload'
import { errorMessage, savedDay, useLinksChanged, usePollWhile } from './useLinks'
import { withRecentPlace } from './useReadingPlace'

const linkTo = (l: Pick<LinkView, 'space' | 'id'>) =>
  `/links/${encodeURIComponent(l.space)}/${encodeURIComponent(l.id)}`

/** `/links`: the read-later list, Unread or Archive, by tag or words (ARCHITECTURE §23.6). */
export default function LinksPage() {
  const { notify, spaces } = useSession()
  const personal = spaces.find((s) => s.kind === 'personal')?.name ?? 'team'
  const pdfInput = useRef<HTMLInputElement>(null)
  const [adding, setAdding] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [params, setParams] = useSearchParams()
  const viewParam = params.get('view')
  const view = viewParam === 'archive' || viewParam === 'highlights' ? viewParam : 'unread'
  const tag = params.get('tag') ?? ''
  const [q, setQ] = useState(params.get('q') ?? '')
  const [links, setLinks] = useState<LinkView[] | null>(null)
  const [tags, setTags] = useState<Array<{ name: string; count: number }>>([])
  const [failed, setFailed] = useState(false)
  const [url, setUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const [marks, setMarks] = useState<HighlightView[] | null>(null)

  const load = useCallback(() => {
    const query = params.get('q') ?? ''
    if (view === 'highlights') {
      linksApi.highlights(query ? { q: query } : {}).then(
        (r) => {
          setMarks(r.highlights)
          setFailed(false)
        },
        () => setFailed(true),
      )
      return
    }
    linksApi.list({ view, ...(tag ? { tag } : {}), ...(query ? { q: query } : {}) }).then(
      (r) => {
        setLinks(r.links.map(withRecentPlace))
        setFailed(false)
      },
      () => setFailed(true),
    )
    linksApi.tags().then(setTags, () => {})
  }, [view, tag, params])

  useEffect(() => {
    document.title = `Links · ${product()}`
    load()
  }, [load])
  useLinksChanged(load)
  usePollWhile(links?.some((l) => l.status === 'fetching') ?? false, load)

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!url.trim()) return
    setSaving(true)
    setSaveError(null)
    try {
      const saved = await linksApi.save({ url: url.trim(), source: 'web' })
      setUrl('')
      if (saved.existing) notify('You saved that one already; it’s back in Unread')
      if (view !== 'unread') set('view', '')
      else load()
    } catch (e) {
      setSaveError(errorMessage(e, 'That didn’t save. Check your connection and try again.'))
    } finally {
      setSaving(false)
    }
  }

  /** PDFs from the computer: each uploaded to Files and saved as a link (R6). */
  const addPdfs = async (files: Iterable<File>) => {
    setSaveError(null)
    const list = [...files]
    const problems = list.map(pdfProblem).filter((p): p is string => p !== null)
    const good = list.filter((f) => pdfProblem(f) === null)
    if (problems.length > 0) setSaveError(problems.join('. '))
    if (good.length === 0) return
    setAdding((n) => n + good.length)
    await Promise.all(
      good.map(async (file) => {
        try {
          const saved = await addPdf(file, personal)
          if (saved.existing) notify('You saved that PDF already')
        } catch (e) {
          setSaveError(errorMessage(e, `${file.name} didn’t save. Check your connection.`))
        } finally {
          setAdding((n) => n - 1)
        }
      }),
    )
    if (view !== 'unread') set('view', '')
    else load()
  }

  const dropProps = {
    onDragOver: (e: DragEvent) => {
      if (![...e.dataTransfer.types].includes('Files')) return
      e.preventDefault()
      setDragging(true)
    },
    onDragLeave: (e: DragEvent) => {
      if (e.currentTarget === e.target) setDragging(false)
    },
    onDrop: (e: DragEvent) => {
      if (e.dataTransfer.files.length === 0) return
      e.preventDefault()
      setDragging(false)
      void addPdfs(e.dataTransfer.files)
    },
  }

  const toggleDone = async (l: LinkView) => {
    setLinks((cur) => cur?.filter((x) => x.id !== l.id || x.space !== l.space) ?? null)
    try {
      await linksApi.update(l.space, l.id, { archived: !l.archived })
      notify(l.archived ? 'Moved back to Unread' : 'Marked done')
    } catch (e) {
      notify(errorMessage(e, 'That didn’t save. Check your connection and try again.'))
      load()
    }
  }

  useListKeys()
  const focusedLink = () => {
    const key = focusedRow('data-link-key')
    return links?.find((l) => `${l.space}/${l.id}` === key)
  }
  useShortcut('links.done', () => {
    const l = focusedLink()
    if (!l) return false
    holdListPlace()
    void toggleDone(l)
  })
  useShortcut('links.original', () => {
    const l = focusedLink()
    if (!l?.url) return false
    window.open(l.url, '_blank', 'noopener')
  })

  const retry = async (l: LinkView) => {
    try {
      const next = await linksApi.refetch(l.space, l.id)
      setLinks((cur) => cur?.map((x) => (x.id === l.id && x.space === l.space ? next : x)) ?? null)
    } catch (e) {
      notify(errorMessage(e, 'Couldn’t try again. Check your connection.'))
    }
  }

  return (
    <>
      <PageHeader title="Links" menu={false}>
        <MainButton
          icon="plus"
          testId="links-save-main"
          onClick={() => {
            const field = document.querySelector<HTMLInputElement>('[data-testid="links-paste"]')
            field?.scrollIntoView({ block: 'center' })
            field?.focus()
          }}
        >
          Save a link
        </MainButton>
      </PageHeader>
      <div
        className={`min-h-0 flex-1 overflow-y-auto ${dragging ? 'bg-ember/5 outline-2 -outline-offset-4 outline-ember outline-dashed' : ''}`}
        data-testid="links-drop"
        {...dropProps}
      >
        <ListColumn width="reading">
          <ListBar
            tabs={[
              { id: 'unread', label: 'Unread', testId: 'links-view-unread' },
              { id: 'archive', label: 'Archive', testId: 'links-view-archive' },
              { id: 'highlights', label: 'Highlights', testId: 'links-view-highlights' },
            ]}
            tab={view}
            onTab={(v) => set('view', v === 'unread' ? '' : v)}
            tabsLabel="Which saved pages"
            search={{
              value: q,
              onChange: (value) => {
                setQ(value)
                if (!value) set('q', '')
              },
              onSubmit: () => set('q', q.trim()),
              label: 'Search saved pages',
              placeholder:
                view === 'highlights' ? 'Search highlights and notes' : 'Search saved pages',
              testId: 'links-search',
            }}
            className="mb-4"
          />
          <form onSubmit={save} className="mb-4 flex gap-2">
            <input
              data-testid="links-paste"
              className={inputClass}
              type="url"
              inputMode="url"
              placeholder="Paste a link to save"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              aria-label="Link to save"
            />
            <button type="submit" className={secondaryButton} disabled={saving || !url.trim()}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              data-testid="links-add-pdf"
              className={`${secondaryButton} shrink-0 whitespace-nowrap`}
              disabled={adding > 0}
              onClick={() => pdfInput.current?.click()}
              title="Add a PDF from your computer (or drop it on this page)"
            >
              <Icon name="upload" />
              <span className="hidden sm:inline">{adding > 0 ? 'Adding…' : 'Add a PDF'}</span>
              <span className="sr-only sm:hidden">Add a PDF</span>
            </button>
            <input
              ref={pdfInput}
              type="file"
              accept="application/pdf,.pdf"
              multiple
              hidden
              data-testid="links-pdf-input"
              onChange={(e) => {
                const files = e.target.files ? [...e.target.files] : []
                e.target.value = ''
                void addPdfs(files)
              }}
            />
          </form>
          {saveError ? (
            <p role="alert" className="mb-2 text-sm text-ember-strong">
              {saveError}
            </p>
          ) : null}

          {tags.length > 0 && view !== 'highlights' ? (
            <fieldset className="mb-4 flex flex-wrap gap-1.5">
              <legend className="sr-only">Tags</legend>
              {tags.map((t) => (
                <button
                  key={t.name}
                  type="button"
                  data-testid="links-tag"
                  aria-pressed={tag === t.name}
                  onClick={() => set('tag', tag === t.name ? '' : t.name)}
                  className={`rounded-full border px-2.5 py-0.5 text-xs ${tag === t.name ? 'border-ember bg-ember/10 text-ink' : 'border-ash-strong text-ink-soft hover:text-ink'}`}
                >
                  {t.name} <span className="text-ink-faint">{t.count}</span>
                </button>
              ))}
            </fieldset>
          ) : null}

          {failed ? <LoadError things="links" onRetry={load} className="mb-4" /> : null}
          {view === 'highlights' ? (
            <HighlightList marks={marks} failed={failed} filtered={!!params.get('q')} />
          ) : links === null ? (
            failed ? null : (
              <p className="text-sm text-ink-soft">Loading…</p>
            )
          ) : links.length === 0 && failed ? null : links.length === 0 ? (
            <EmptyList view={view} filtered={!!tag || !!params.get('q')} />
          ) : (
            <ul className="divide-y divide-ash/70" data-testid="links-list">
              {links.map((l) => (
                <LinkRow
                  key={`${l.space}/${l.id}`}
                  link={l}
                  onDone={() => toggleDone(l)}
                  onRetry={() => retry(l)}
                  onTag={(t) => set('tag', t)}
                />
              ))}
            </ul>
          )}
        </ListColumn>
      </div>
    </>
  )
}

function HighlightList({
  marks,
  failed,
  filtered,
}: {
  marks: HighlightView[] | null
  failed: boolean
  filtered: boolean
}) {
  const { me } = useSession()
  const mine = me?.principal.email.toLowerCase()
  if (marks === null) return failed ? null : <p className="text-sm text-ink-soft">Loading…</p>
  if (marks.length === 0) {
    if (failed) return null
    if (filtered) return <EmptyState icon="bookmark" title="No highlights match" />
    return (
      <EmptyState icon="bookmark" title="No highlights yet" testId="links-highlights-empty">
        Open a saved page and select words to highlight them or add a note.
      </EmptyState>
    )
  }
  return (
    <ul className="divide-y divide-ash/70" data-testid="links-highlight-list">
      {marks.map((h) => (
        <li
          key={`${h.link.space}/${h.link.id}/${h.id}`}
          className="py-4"
          data-testid="highlight-row"
        >
          <Link
            to={`${linkTo(h.link)}?highlight=${encodeURIComponent(h.id)}`}
            className={`block border-l-2 pl-3 text-sm text-ink hover:text-ember-strong ${h.by === mine ? 'border-ember' : 'border-ash-strong'}`}
          >
            <span className="line-clamp-4">{h.quote}</span>
          </Link>
          {h.note ? (
            <p className="mt-1 pl-3.5 text-sm whitespace-pre-wrap text-ink-soft">{h.note}</p>
          ) : null}
          <p className="mt-1 truncate pl-3.5 text-xs text-ink-faint">
            {[h.link.title || h.link.site, h.by === mine ? '' : h.name, `${savedDay(h.at)}`]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </li>
      ))}
    </ul>
  )
}

function EmptyList({ view, filtered }: { view: 'unread' | 'archive'; filtered: boolean }) {
  if (filtered) return <EmptyState icon="bookmark" title="No saved pages match" />
  if (view === 'archive') {
    return (
      <EmptyState icon="bookmark" title="Nothing done yet">
        Pages you mark done land here.
      </EmptyState>
    )
  }
  return (
    <EmptyState icon="bookmark" title="Nothing to read yet" testId="links-empty">
      Pages, PDFs and papers saved to read later, each with a readable copy that search and your AI
      tools can find. Paste a link above, click the Chrome extension, or share a page from your
      phone.
    </EmptyState>
  )
}

function LinkRow({
  link: l,
  onDone,
  onRetry,
  onTag,
}: {
  link: LinkView
  onDone: () => void
  onRetry: () => void
  onTag: (tag: string) => void
}) {
  const { spaceLabel } = useSession()
  const blurb = l.summary || l.description
  const progress = readProgress(l.reading)
  const furthest = l.reading?.furthest ?? 0
  return (
    <li
      className="group flex gap-3 py-4"
      data-testid="link-row"
      data-link-key={`${l.space}/${l.id}`}
      data-list-row
    >
      <div className="min-w-0 flex-1">
        <Link
          to={linkTo(l)}
          data-testid="link-title"
          data-list-item
          className="line-clamp-2 font-medium text-ink hover:text-ember-strong"
        >
          {l.title || l.url || 'Untitled PDF'}
        </Link>
        <p className="mt-0.5 truncate text-xs text-ink-faint">
          {[
            linkKindLabel(l),
            l.site,
            readingTime(l.words),
            progress,
            highlightLabel(l.highlightCount),
            `saved ${savedDay(l.saved)}`,
          ]
            .filter(Boolean)
            .join(' · ')}
          {l.space === 'team' ? ` · ${spaceLabel('team')}` : ''}
        </p>
        {progress && furthest < READ_TO_END ? (
          <div
            className="mt-1.5 h-1 w-full max-w-48 overflow-hidden rounded-full bg-ash/70"
            role="progressbar"
            aria-label="How much you've read"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.floor(furthest)}
            data-testid="link-progress-bar"
          >
            <div className="h-full rounded-full bg-ember" style={{ width: `${furthest}%` }} />
          </div>
        ) : null}
        {l.status === 'waiting' ? (
          <p className="mt-1 text-sm text-ink-soft" data-testid="link-waiting">
            <span className="break-all">{l.url}</span>
            <br />
            Saved by an AI tool. Check the address, then{' '}
            <button type="button" className="text-ember-strong underline" onClick={onRetry}>
              Get the page
            </button>
          </p>
        ) : l.status === 'fetching' ? (
          <p className="mt-1 text-sm text-ink-soft" data-testid="link-fetching">
            Getting the page…
          </p>
        ) : l.status === 'failed' ? (
          <p className="mt-1 text-sm text-ink-soft" data-testid="link-failed">
            {l.fetchError ?? 'Couldn’t get the page'}{' '}
            <button type="button" className="text-ember-strong underline" onClick={onRetry}>
              Try again
            </button>
          </p>
        ) : blurb ? (
          <p className="mt-1 line-clamp-2 text-sm text-ink-soft">{blurb}</p>
        ) : null}
        {l.tags.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {l.tags.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => onTag(t)}
                className="rounded-full bg-ash/60 px-2 py-0.5 text-xs text-ink-soft hover:text-ink"
              >
                {t}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-start gap-1">
        {l.url ? (
          <a
            href={webUrl(l.url) ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            className="grid size-9 place-items-center rounded-lg text-ink-soft hover:bg-ash/60 hover:text-ink"
            aria-label="Open the original page"
            title="Open the original page"
          >
            <Icon name="external" />
          </a>
        ) : null}
        <button
          type="button"
          data-testid="link-done"
          onClick={onDone}
          className="grid size-9 place-items-center rounded-lg text-ink-soft hover:bg-ash/60 hover:text-ink"
          aria-label={l.archived ? 'Move to Unread' : 'Mark done'}
          title={l.archived ? 'Move to Unread' : 'Mark done'}
        >
          <Icon name={l.archived ? 'inbox' : 'check'} />
        </button>
      </div>
    </li>
  )
}
