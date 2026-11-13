import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { type LinkView, linksApi, readingTime, webUrl } from '../../api/links'
import { product } from '../../brand/product'
import { Icon } from '../../components/Icon'
import { focusedRow, holdListPlace, useListKeys } from '../../keyboard/listKeys'
import { useShortcut } from '../../keyboard/shortcuts'
import { inputClass } from '../../routes/org/fields'
import { useSession } from '../../state/session'
import { MeetingsPageHeader, primaryButton } from '../meetings/components/common'
import { errorMessage, savedDay, useLinksChanged, usePollWhile } from './useLinks'

const linkTo = (l: Pick<LinkView, 'space' | 'id'>) =>
  `/links/${encodeURIComponent(l.space)}/${encodeURIComponent(l.id)}`

/** `/links`: the read-later list, Unread or Archive, by tag or words (ARCHITECTURE §23.6). */
export default function LinksPage() {
  const { notify } = useSession()
  const [params, setParams] = useSearchParams()
  const view = params.get('view') === 'archive' ? 'archive' : 'unread'
  const tag = params.get('tag') ?? ''
  const [q, setQ] = useState(params.get('q') ?? '')
  const [links, setLinks] = useState<LinkView[] | null>(null)
  const [tags, setTags] = useState<Array<{ name: string; count: number }>>([])
  const [error, setError] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const load = useCallback(() => {
    const query = params.get('q') ?? ''
    linksApi.list({ view, ...(tag ? { tag } : {}), ...(query ? { q: query } : {}) }).then(
      (r) => {
        setLinks(r.links)
        setError(null)
      },
      (e: unknown) => setError(errorMessage(e, 'Couldn’t load your links')),
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
    if (!l) return false
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
      <MeetingsPageHeader title="Links" menu={false} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 pt-6 pb-24 md:px-8">
          <p className="mb-4 text-sm text-ink-soft">
            Pages saved to read later. Each keeps a readable copy, so search, Ask and Claude can
            find it.
          </p>
          <form onSubmit={save} className="mb-1 flex gap-2">
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
            <button type="submit" className={primaryButton} disabled={saving || !url.trim()}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </form>
          {saveError ? (
            <p role="alert" className="mb-2 text-sm text-ember-strong">
              {saveError}
            </p>
          ) : null}

          <div className="mt-5 mb-3 flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border border-ash-strong p-0.5" role="tablist">
              {(['unread', 'archive'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={view === v}
                  data-testid={`links-view-${v}`}
                  onClick={() => set('view', v === 'unread' ? '' : v)}
                  className={`h-8 rounded-md px-3 text-sm ${view === v ? 'bg-ash text-ink' : 'text-ink-soft hover:text-ink'}`}
                >
                  {v === 'unread' ? 'Unread' : 'Archive'}
                </button>
              ))}
            </div>
            <form
              className="min-w-40 flex-1"
              onSubmit={(e) => {
                e.preventDefault()
                set('q', q.trim())
              }}
            >
              <input
                data-testid="links-search"
                className={`${inputClass} h-9`}
                type="search"
                placeholder="Search saved pages"
                value={q}
                onChange={(e) => {
                  setQ(e.target.value)
                  if (!e.target.value) set('q', '')
                }}
                aria-label="Search saved pages"
              />
            </form>
          </div>
          {tags.length > 0 ? (
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

          {error ? (
            <p role="alert" className="text-sm text-ember-strong">
              {error}
            </p>
          ) : links === null ? (
            <p className="text-sm text-ink-soft">Loading…</p>
          ) : links.length === 0 ? (
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
        </div>
      </div>
    </>
  )
}

function EmptyList({ view, filtered }: { view: 'unread' | 'archive'; filtered: boolean }) {
  if (filtered) return <p className="text-sm text-ink-soft">No saved pages match.</p>
  if (view === 'archive') {
    return <p className="text-sm text-ink-soft">Pages you mark done land here.</p>
  }
  return (
    <div className="rounded-xl border border-dashed border-ash-strong p-6 text-sm text-ink-soft">
      <p className="mb-2 font-medium text-ink">Nothing to read yet.</p>
      <p>
        Paste a link above, use “Save to {product()}” in the Chrome extension, or share a page to{' '}
        {product()} from your phone.
      </p>
    </div>
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
          {l.title || l.url}
        </Link>
        <p className="mt-0.5 truncate text-xs text-ink-faint">
          {[l.site, readingTime(l.words), `saved ${savedDay(l.saved)}`].filter(Boolean).join(' · ')}
          {l.space === 'team' ? ` · ${spaceLabel('team')}` : ''}
        </p>
        {l.status === 'fetching' ? (
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
