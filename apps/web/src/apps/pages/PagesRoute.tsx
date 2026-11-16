import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { type PageSummary, type PageView, pagesApi } from '../../api/shares'
import { product } from '../../brand/product'
import { useShell } from '../../components/AppShell'
import { EmptyState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { ItemStatus } from '../../components/ItemStatus'
import {
  inScope,
  ListBar,
  ListColumn,
  ListPanel,
  matchesName,
  scopeTabs,
  useScope,
} from '../../components/ListBar'
import { LoadError } from '../../components/LoadError'
import { MenuItem } from '../../components/Menu'
import { PageFrame } from '../../components/PageFrame'
import { MoreMenu } from '../../components/PageHeader'
import { ReadOnlyLinkItems, useReadOnlyLink } from '../../components/ReadOnlyLink'
import { ShareButton } from '../../components/ShareButton'
import { useLoad } from '../../hooks/useLoad'
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

/** `/pages`: HTML pages AI tools published (ARCHITECTURE §20.2), newest first. */
export function PagesList() {
  const { spaceLabel, spaces } = useSession()
  const list = useLoad(() => pagesApi.list().then((r) => r.pages))
  const pages: PageSummary[] | null = list.data
  const [q, setQ] = useState('')
  const [scope, setScope] = useScope(['all', 'mine', 'team'])
  const teamSpace = spaces.find((s) => s.kind === 'team')?.name ?? null
  const shown = pages?.filter((p) => inScope(scope, p.space, teamSpace) && matchesName(p.title, q))
  useEffect(() => {
    document.title = `Pages · ${product()}`
  }, [])
  return (
    <>
      <MeetingsPageHeader title="Pages" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ListColumn width="reading">
          <ListBar
            tabs={scopeTabs(['all', 'mine', 'team'], 'pages')}
            tab={scope}
            onTab={setScope}
            tabsLabel="Whose pages"
            search={{ value: q, onChange: setQ, label: 'Search pages', testId: 'pages-search' }}
          />
          <ListPanel tab={scope}>
            {list.failed ? <LoadError things="pages" whose="the" onRetry={list.reload} /> : null}
            {!list.failed && pages && pages.length === 0 ? (
              <EmptyState icon="tab" title="No pages yet" testId="pages-empty">
                Plans and reports your AI tools published for the team. Ask yours to “publish this
                as a page” and it appears here, with every version kept.
              </EmptyState>
            ) : null}
            {!list.failed && pages && pages.length > 0 && shown?.length === 0 ? (
              <EmptyState
                icon="tab"
                title={
                  q.trim()
                    ? 'No pages match that'
                    : scope === 'team'
                      ? 'No team pages yet'
                      : 'No personal pages yet'
                }
                testId="pages-no-match"
              >
                {q.trim()
                  ? 'Search looks at page names.'
                  : scope === 'team'
                    ? 'Pages shared with the team show here.'
                    : 'Pages only you can see show here.'}
              </EmptyState>
            ) : null}
            <ul className="divide-y divide-ash/70" data-testid="pages-list">
              {(shown ?? []).map((p) => (
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
          </ListPanel>
        </ListColumn>
      </div>
    </>
  )
}

/** `/pages/:space/:id`: one page, any of its versions, and its read-only link. */
export function PageRoute() {
  const { space = '', id = '' } = useParams()
  const navigate = useNavigate()
  const { notify, spaceLabel } = useSession()
  const [version, setVersion] = useState<string | undefined>(undefined)
  const [page, setPage] = useState<PageView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const link = useReadOnlyLink(space, `pages/${id}.md`)
  const { compact } = useShell()

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

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      notify('Link copied. Anyone who can see this space can open it.')
    } catch {
      notify('Couldn’t copy the link. Copy it from the address bar instead.')
    }
  }

  const remove = async () => {
    if (!window.confirm('Delete this page? It moves to the trash with all its versions.')) return
    try {
      await pagesApi.remove(space, id)
      notify('Page deleted.')
      navigate('/pages')
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Couldn’t delete the page')
    }
  }

  const versionPicker =
    page && page.versions.length > 1 ? (
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
    ) : null
  const shareItems = (close: () => void) => (
    <>
      <MenuItem
        icon="link"
        testId="page-copy-link"
        onSelect={() => {
          close()
          void copyLink()
        }}
      >
        Copy link
      </MenuItem>
      <ReadOnlyLinkItems link={link} close={close} />
    </>
  )

  return (
    <>
      <MeetingsPageHeader title={page?.title ?? 'Page'} back={{ to: '/pages', label: 'Pages' }}>
        {page ? <ItemStatus whose={spaceLabel(page.space)} /> : null}
        {compact ? null : versionPicker}
        {compact ? null : (
          <ShareButton testId="page-share" onOpen={() => link.refresh()}>
            {shareItems}
          </ShareButton>
        )}
        <MoreMenu onOpen={() => link.refresh()}>
          {(close) => (
            <>
              {compact ? shareItems(close) : null}
              <MenuItem
                icon="trash"
                danger
                testId="page-delete"
                onSelect={() => {
                  close()
                  void remove()
                }}
              >
                Delete page
              </MenuItem>
            </>
          )}
        </MoreMenu>
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
            {compact && versionPicker ? <div className="px-4 pb-2">{versionPicker}</div> : null}
            <PageFrame html={page.html} title={page.title} />
          </>
        ) : null}
      </div>
    </>
  )
}
