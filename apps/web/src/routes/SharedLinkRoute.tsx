import { useEffect, useMemo, useState } from 'react'
import Markdown, { type Components } from 'react-markdown'
import { Link, useLocation, useParams } from 'react-router'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { HearthApiError } from '../api/client'
import { type SharedItem, sharesApi } from '../api/shares'
import { useAuthState } from '../auth/AuthContext'
import { org, product } from '../brand/product'
import { BrandMark } from '../components/BrandMark'
import { PageFrame } from '../components/PageFrame'
import { isExternalHref } from '../lib/paths'
import { remarkCallouts } from '../lib/remarkCallouts'

type Load =
  | { status: 'loading' }
  | { status: 'ready'; item: SharedItem }
  | { status: 'sign-in' }
  | { status: 'missing' }
  | { status: 'error'; message: string }

const KIND_LABEL: Record<SharedItem['kind'], string> = {
  doc: 'Doc',
  meeting: 'Meeting notes',
  note: 'Note',
  page: 'Page',
}

/**
 * `/s/:token`: a read-only link (ARCHITECTURE §20), outside the app shell so it opens without
 * Hearth's sidebar, and signed out when the organization allows "anyone with the link".
 */
export default function SharedLinkRoute() {
  const { token = '' } = useParams()
  const auth = useAuthState()
  const location = useLocation()
  const [load, setLoad] = useState<Load>({ status: 'loading' })

  useEffect(() => {
    if (auth.status === 'loading') return
    let live = true
    setLoad({ status: 'loading' })
    sharesApi.open(token).then(
      (item) => {
        if (!live) return
        setLoad({ status: 'ready', item })
        document.title = `${item.title} · ${product()}`
      },
      (err: unknown) => {
        if (!live) return
        if (err instanceof HearthApiError && err.status === 401) setLoad({ status: 'sign-in' })
        else if (err instanceof HearthApiError && err.status === 404) setLoad({ status: 'missing' })
        else setLoad({ status: 'error', message: err instanceof Error ? err.message : 'Failed' })
      },
    )
    return () => {
      live = false
    }
  }, [token, auth.status])

  const item = load.status === 'ready' ? load.item : null
  return (
    <div className="flex min-h-full flex-col bg-paper" data-testid="shared-link">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-ash px-4 md:px-6">
        <BrandMark className="size-5" />
        <span className="font-display text-sm font-semibold text-ink">{product()}</span>
        <span className="rounded-full bg-paper-sunk px-2 py-0.5 text-[11px] font-medium text-ink-soft">
          Read-only
        </span>
        {auth.status === 'signed-in' ? (
          <Link to="/docs" className="ml-auto text-sm text-ink-soft hover:text-ink">
            Open {product()}
          </Link>
        ) : null}
      </header>
      {item?.kind === 'page' ? (
        <main className="flex min-h-0 flex-1 flex-col">
          <Meta item={item} className="px-4 py-2 md:px-6" />
          <PageFrame html={item.html ?? ''} title={item.title} />
        </main>
      ) : (
        <main className="w-full flex-1">
          {item ? (
            <>
              {/* Lined up with the article, which brings its own width and padding. */}
              <Meta item={item} className="mx-auto max-w-[var(--measure)] px-4 pt-8 md:px-6" />
              <SharedMarkdown token={token} markdown={item.markdown} />
            </>
          ) : load.status === 'sign-in' ? (
            <Notice title="Sign in to read this">
              <p>
                This link opens for people who can sign in to {org() || product()}.{' '}
                <Link
                  to="/sign-in"
                  state={{ from: location.pathname }}
                  className="font-medium text-ember-strong underline"
                  data-testid="shared-sign-in"
                >
                  Sign in
                </Link>{' '}
                and it opens here.
              </p>
            </Notice>
          ) : load.status === 'missing' ? (
            <Notice title="This link doesn’t open">
              <p>It was turned off, or the address isn’t quite right. Ask whoever sent it.</p>
            </Notice>
          ) : load.status === 'error' ? (
            <Notice title="Couldn’t open the link">
              <p>{load.message}</p>
            </Notice>
          ) : (
            <p className="mx-auto mt-16 max-w-md px-5 text-sm text-ink-faint">Loading…</p>
          )}
        </main>
      )}
    </div>
  )
}

function Meta({ item, className = '' }: { item: SharedItem; className?: string }) {
  const when = item.updated
    ? new Date(item.updated).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : null
  return (
    <p className={`text-xs text-ink-faint ${className}`} data-testid="shared-meta">
      {KIND_LABEL[item.kind]}
      {when ? ` · Updated ${when}` : ''}
      {item.updatedBy ? ` by ${item.updatedBy}` : ''}
    </p>
  )
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto mt-16 max-w-md px-5" role="alert">
      <h1 className="font-display text-2xl font-semibold text-ink">{title}</h1>
      <div className="mt-2 text-ink-soft">{children}</div>
    </div>
  )
}

/** The doc rendered as Docs' reading view does, minus links into the space it came from. */
function SharedMarkdown({ token, markdown }: { token: string; markdown: string }) {
  const components = useMemo<Components>(
    () => ({
      a: ({ href = '', children }) =>
        isExternalHref(href) || href.startsWith('#') ? (
          <a
            href={href}
            {...(isExternalHref(href) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          >
            {children}
          </a>
        ) : (
          // A link to another file in the space: the reader can't open it from here.
          <span>{children}</span>
        ),
      img: ({ src, alt }) =>
        typeof src === 'string' ? <SharedImage token={token} src={src} alt={alt ?? ''} /> : null,
    }),
    [token],
  )
  return (
    <article className="prose-hearth" data-testid="shared-markdown">
      <Markdown
        remarkPlugins={[remarkGfm, remarkCallouts]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
      >
        {markdown}
      </Markdown>
    </article>
  )
}

function SharedImage({ token, src, alt }: { token: string; src: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(isExternalHref(src) ? src : null)
  useEffect(() => {
    if (isExternalHref(src)) return
    let live = true
    let made: string | null = null
    sharesApi.image(token, src).then(
      (u) => {
        made = u
        if (live) setUrl(u)
        else URL.revokeObjectURL(u)
      },
      () => {},
    )
    return () => {
      live = false
      if (made) URL.revokeObjectURL(made)
    }
  }, [token, src])
  return url ? <img src={url} alt={alt} /> : <span className="block h-10" aria-hidden="true" />
}
