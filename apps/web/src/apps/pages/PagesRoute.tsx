import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { type PageSummary, type PageView, pagesApi } from '../../api/shares'
import { product } from '../../brand/product'
import { Icon } from '../../components/Icon'
import { below, Menu, type MenuAnchor } from '../../components/Menu'
import { PageFrame } from '../../components/PageFrame'
import { ReadOnlyLinkItems, useReadOnlyLink } from '../../components/ReadOnlyLink'
import { useSession } from '../../state/session'
import { MeetingsPageHeader } from '../meetings/components/common'

const day = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : ''

/** `/pages`: HTML pages Claude published (ARCHITECTURE §20.2), newest first. */
export function PagesList() {
  const { spaceLabel } = useSession()
  const [pages, setPages] = useState<PageSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    document.title = `Pages · ${product()}`
    pagesApi.list().then(
      (r) => setPages(r.pages),
      (e: unknown) => setError(e instanceof Error ? e.message : 'Couldn’t load pages'),
    )
  }, [])
  return (
    <>
      <MeetingsPageHeader title="Pages" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 pt-6 pb-24 md:px-8">
          <p className="mb-5 text-sm text-ink-soft">
            Plans and reports Claude published for the team. Ask Claude to “publish this as a page”
            and it appears here, with every version kept.
          </p>
          {error ? (
            <p role="alert" className="rounded-lg bg-ember-wash px-3 py-2 text-sm text-ink">
              {error}
            </p>
          ) : null}
          {pages && pages.length === 0 ? (
            <p className="text-sm text-ink-faint" data-testid="pages-empty">
              No pages yet.
            </p>
          ) : null}
          <ul className="divide-y divide-ash/70" data-testid="pages-list">
            {(pages ?? []).map((p) => (
              <li key={`${p.space}/${p.id}`}>
                <Link
                  to={`/pages/${encodeURIComponent(p.space)}/${p.id}`}
                  className="flex items-baseline gap-3 rounded-md px-2 py-3 hover:bg-paper-sunk"
                >
                  <Icon name="docs" className="size-4 shrink-0 self-center text-ink-faint" />
                  <span className="min-w-0 flex-1 truncate font-medium text-ink">{p.title}</span>
                  {p.shared ? <Icon name="link" className="size-3.5 text-ink-faint" /> : null}
                  <span className="shrink-0 text-xs text-ink-faint">
                    {spaceLabel(p.space)} · {day(p.updated)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  )
}

/** `/pages/:space/:id`: one page, any of its versions, and its read-only link. */
export function PageRoute() {
  const { space = '', id = '' } = useParams()
  const navigate = useNavigate()
  const { notify } = useSession()
  const [version, setVersion] = useState<string | undefined>(undefined)
  const [page, setPage] = useState<PageView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null)
  const link = useReadOnlyLink(space, `pages/${id}.md`)

  useEffect(() => {
    let live = true
    pagesApi.get(space, id, version).then(
      (p) => {
        if (!live) return
        setPage(p)
        document.title = `${p.title} · ${product()}`
      },
      (e: unknown) => live && setError(e instanceof Error ? e.message : 'Couldn’t open the page'),
    )
    return () => {
      live = false
    }
  }, [space, id, version])

  const remove = async () => {
    setAnchor(null)
    if (!window.confirm('Delete this page? It moves to the trash with all its versions.')) return
    try {
      await pagesApi.remove(space, id)
      notify('Page deleted.')
      navigate('/pages')
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Couldn’t delete the page')
    }
  }

  return (
    <>
      <MeetingsPageHeader title={page?.title ?? 'Page'}>
        {page && page.versions.length > 1 ? (
          <select
            aria-label="Version"
            data-testid="page-version"
            value={version ?? ''}
            onChange={(e) => setVersion(e.target.value || undefined)}
            className="h-8 rounded-lg border border-ash bg-paper px-2 text-sm text-ink"
          >
            {page.versions.map((v, i) => (
              <option key={v.oid} value={i === 0 ? '' : v.oid}>
                {i === 0 ? 'Latest' : `Version ${page.versions.length - i}`} · {day(v.date)}
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          data-testid="page-share"
          aria-haspopup="menu"
          onClick={(e) => {
            if (!anchor) link.refresh()
            setAnchor(anchor ? null : below(e.currentTarget))
          }}
          className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm text-ink-soft hover:bg-paper-sunk hover:text-ink"
        >
          <Icon name="share" />
          Share
        </button>
        {anchor ? (
          <Menu anchor={anchor} label="Share" onClose={() => setAnchor(null)}>
            <ReadOnlyLinkItems link={link} close={() => setAnchor(null)} />
            <button
              type="button"
              role="menuitem"
              data-testid="page-delete"
              onClick={() => void remove()}
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm text-ember-strong hover:bg-ember-wash"
            >
              <Icon name="trash" />
              Delete page
            </button>
          </Menu>
        ) : null}
      </MeetingsPageHeader>
      <div className="flex min-h-0 flex-1 flex-col">
        {error ? (
          <p role="alert" className="m-4 rounded-lg bg-ember-wash px-3 py-2 text-sm text-ink">
            {error}
          </p>
        ) : null}
        {page ? (
          <>
            <p className="px-4 py-1.5 text-xs text-ink-faint md:px-6">
              {page.updatedBy ? `Published by ${page.updatedBy}` : 'Published'} ·{' '}
              {day(page.updated)}
              {page.versions.length > 1 ? ` · ${page.versions.length} versions` : ''}
            </p>
            <PageFrame html={page.html} title={page.title} />
          </>
        ) : null}
      </div>
    </>
  )
}
