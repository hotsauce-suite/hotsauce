import { useEffect, useMemo, useState } from 'react'
import Markdown, { type Components } from 'react-markdown'
import { Link, useLocation, useParams } from 'react-router'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { HotsauceApiError } from '../api/client'
import { type SharedItem, sharesApi } from '../api/shares'
import { SharedClipView } from '../apps/clips/SharedClipView'
import { FilePreview } from '../apps/files/Preview'
import { primaryButton } from '../apps/meetings/components/common'
import { useAuthState } from '../auth/AuthContext'
import { org, product } from '../brand/product'
import { BrandMark } from '../components/BrandMark'
import { Icon } from '../components/Icon'
import { PageFrame } from '../components/PageFrame'
import { isExternalHref } from '../lib/paths'
import { remarkCallouts } from '../lib/remarkCallouts'

type Load =
  | { status: 'loading' }
  | { status: 'ready'; item: SharedItem }
  | { status: 'sign-in' }
  | { status: 'missing' }
  | { status: 'ended' }
  | { status: 'error'; message: string }

const KIND_LABEL: Record<SharedItem['kind'], string> = {
  doc: 'Doc',
  meeting: 'Meeting notes',
  note: 'Note',
  page: 'Page',
  clip: 'Clip',
  file: 'File',
}

/**
 * `/s/:token`: a read-only link (ARCHITECTURE §20), outside the app shell so it opens without
 * Hotsauce's sidebar, and signed out when the organization allows "anyone with the link".
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
        if (err instanceof HotsauceApiError && err.status === 401) setLoad({ status: 'sign-in' })
        else if (err instanceof HotsauceApiError && err.status === 404)
          setLoad({ status: 'missing' })
        else if (err instanceof HotsauceApiError && err.status === 410) setLoad({ status: 'ended' })
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
      {item?.kind === 'clip' ? (
        <main className="w-full flex-1">
          <Meta item={item} className="mx-auto max-w-5xl px-4 pt-6 md:px-6" />
          <SharedClipView clip={item} />
        </main>
      ) : item?.kind === 'file' ? (
        <main className="flex w-full flex-1 flex-col">
          <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-3 px-4 pt-6 md:px-6">
            <h1 className="min-w-0 flex-1 font-display text-2xl font-semibold break-words text-ink">
              {item.title}
            </h1>
            <a
              href={item.file.downloadUrl}
              className={`${primaryButton} h-9`}
              data-testid="shared-download"
            >
              <Icon name="download" />
              Download
            </a>
          </div>
          <Meta item={item} className="mx-auto w-full max-w-5xl px-4 pt-1 md:px-6" />
          <div className="mx-auto flex min-h-[60vh] w-full max-w-5xl flex-1 items-center justify-center px-4 py-6 md:px-6">
            <FilePreview file={{ ...item.file, id: token }} />
          </div>
        </main>
      ) : item?.kind === 'page' ? (
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
              {'markdown' in item ? (
                <SharedMarkdown token={token} markdown={item.markdown} />
              ) : null}
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
          ) : load.status === 'ended' ? (
            <Notice title="This link has ended">
              <p>Links end after the time whoever made it chose. Ask them for a new one.</p>
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
    <article className="prose-hotsauce" data-testid="shared-markdown">
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
