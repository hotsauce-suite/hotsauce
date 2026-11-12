import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import Markdown, { type Components } from 'react-markdown'
import { Link, useNavigate, useParams } from 'react-router'
import remarkGfm from 'remark-gfm'
import { type LinkWithBody, linksApi, readingTime, webUrl } from '../../api/links'
import { product } from '../../brand/product'
import { Icon } from '../../components/Icon'
import { inputClass } from '../../routes/org/fields'
import { useSession } from '../../state/session'
import { MeetingsPageHeader, primaryButton, secondaryButton } from '../meetings/components/common'
import { errorMessage, savedDay, useLinksChanged, usePollWhile } from './useLinks'

const isWeb = (href: string) => /^https?:\/\//i.test(href)

// The copy is someone else's page: every link opens outside, and no picture loads from it.
const components: Components = {
  a: ({ href = '', children }) =>
    isWeb(href) ? (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ src, alt }) =>
    typeof src === 'string' && isWeb(src) ? (
      <a href={src} target="_blank" rel="noopener noreferrer nofollow">
        Picture{alt ? `: ${alt}` : ''}
      </a>
    ) : null,
}

/** `/links/:space/:id`: one saved page's readable copy and what to do with it (§23.6). */
export default function LinkReader() {
  const { space = '', id = '' } = useParams()
  const navigate = useNavigate()
  const { me, spaces, spaceLabel, notify } = useSession()
  const [link, setLink] = useState<LinkWithBody | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editingTags, setEditingTags] = useState(false)
  const [tagText, setTagText] = useState('')

  const load = useCallback(() => {
    linksApi.get(space, id).then(
      (l) => {
        setLink(l)
        setError(null)
      },
      (e: unknown) => setError(errorMessage(e, 'Couldn’t open this link')),
    )
  }, [space, id])

  useEffect(load, [load])
  useEffect(() => {
    if (link) document.title = `${link.title || link.site || 'Link'} · ${product()}`
  }, [link])
  useLinksChanged(load)
  usePollWhile(link?.status === 'fetching', load)

  const act = async (work: () => Promise<unknown>, done?: string) => {
    setBusy(true)
    try {
      await work()
      if (done) notify(done)
    } catch (e) {
      notify(errorMessage(e, 'That didn’t save. Check your connection and try again.'))
    } finally {
      setBusy(false)
    }
  }

  const personal = spaces.find((s) => s.kind === 'personal')?.name ?? null
  const mine = !!link && link.savedBy === me?.principal.email.toLowerCase()

  const saveTags = (event: FormEvent) => {
    event.preventDefault()
    if (!link) return
    const tags = tagText
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    void act(async () => {
      const next = await linksApi.update(link.space, link.id, { tags })
      setLink({ ...link, ...next })
      setEditingTags(false)
    })
  }

  const body = useMemo(
    () =>
      link?.body ? (
        <div className="prose-hearth !p-0" data-testid="link-body">
          <Markdown remarkPlugins={[remarkGfm]} components={components}>
            {link.body}
          </Markdown>
        </div>
      ) : null,
    [link?.body],
  )

  if (error) {
    return (
      <>
        <MeetingsPageHeader title="Links" menu={false} />
        <div className="mx-auto w-full max-w-2xl px-4 pt-6 md:px-8">
          <p role="alert" className="text-sm text-ember-strong">
            {error}
          </p>
          <Link to="/links" className="mt-3 inline-block text-sm text-ember-strong underline">
            Back to Links
          </Link>
        </div>
      </>
    )
  }
  if (!link) {
    return (
      <>
        <MeetingsPageHeader title="Links" menu={false} />
        <p className="px-8 pt-6 text-sm text-ink-soft">Loading…</p>
      </>
    )
  }

  return (
    <>
      <MeetingsPageHeader
        title={
          <Link to="/links" className="inline-flex items-center gap-1 hover:text-ember-strong">
            <Icon name="back" />
            Links
          </Link>
        }
        menu={false}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <article className="mx-auto w-full max-w-2xl px-4 pt-6 pb-24 md:px-8">
          <h1
            className="font-display text-2xl font-semibold tracking-tight text-ink"
            data-testid="link-reader-title"
          >
            {link.title || link.url}
          </h1>
          <p className="mt-1 text-sm text-ink-faint">
            <a
              href={webUrl(link.url) ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              className="text-ember-strong hover:underline"
              data-testid="link-original"
            >
              {link.site || 'Open the original'} <Icon name="external" className="inline size-3" />
            </a>
            {' · '}
            {[readingTime(link.words), `saved ${savedDay(link.saved)}`, spaceLabel(link.space)]
              .filter(Boolean)
              .join(' · ')}
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="link-reader-done"
              className={link.archived ? secondaryButton : primaryButton}
              disabled={busy}
              onClick={() =>
                act(
                  async () => {
                    await linksApi.update(link.space, link.id, { archived: !link.archived })
                    if (link.archived) setLink({ ...link, archived: false })
                    else navigate('/links')
                  },
                  link.archived ? 'Moved back to Unread' : 'Marked done',
                )
              }
            >
              <Icon name={link.archived ? 'inbox' : 'check'} />
              {link.archived ? 'Move to Unread' : 'Done'}
            </button>
            {link.space !== 'team' ? (
              <button
                type="button"
                data-testid="link-share-team"
                className={secondaryButton}
                disabled={busy}
                onClick={() =>
                  act(
                    async () => {
                      const moved = await linksApi.move(link.space, link.id, 'team')
                      navigate(`/links/team/${encodeURIComponent(moved.id)}`, { replace: true })
                    },
                    `Shared with ${spaceLabel('team')}`,
                  )
                }
              >
                <Icon name="share" />
                Share with team
              </button>
            ) : mine && personal ? (
              <button
                type="button"
                className={secondaryButton}
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    const moved = await linksApi.move(link.space, link.id, personal)
                    navigate(
                      `/links/${encodeURIComponent(personal)}/${encodeURIComponent(moved.id)}`,
                      {
                        replace: true,
                      },
                    )
                  }, 'Only you can see it now')
                }
              >
                Make private
              </button>
            ) : null}
            <button
              type="button"
              data-testid="link-delete"
              className={secondaryButton}
              disabled={busy}
              onClick={() => {
                if (!window.confirm('Delete this saved link?')) return
                void act(async () => {
                  await linksApi.remove(link.space, link.id)
                  navigate('/links')
                }, 'Deleted')
              }}
            >
              Delete
            </button>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-1.5">
            {editingTags ? (
              <form onSubmit={saveTags} className="flex w-full gap-2">
                <input
                  data-testid="link-tags-input"
                  className={`${inputClass} h-9`}
                  value={tagText}
                  onChange={(e) => setTagText(e.target.value)}
                  placeholder="Tags, separated by commas"
                  aria-label="Tags"
                  // biome-ignore lint/a11y/noAutofocus: opened by a click on "Edit tags"
                  autoFocus
                />
                <button type="submit" className={`${primaryButton} h-9`} disabled={busy}>
                  Save
                </button>
              </form>
            ) : (
              <>
                {link.tags.map((t) => (
                  <Link
                    key={t}
                    to={`/links?tag=${encodeURIComponent(t)}`}
                    className="rounded-full bg-ash/60 px-2 py-0.5 text-xs text-ink-soft hover:text-ink"
                  >
                    {t}
                  </Link>
                ))}
                <button
                  type="button"
                  data-testid="link-edit-tags"
                  className="text-xs text-ink-soft underline hover:text-ink"
                  onClick={() => {
                    setTagText(link.tags.join(', '))
                    setEditingTags(true)
                  }}
                >
                  {link.tags.length > 0 ? 'Edit tags' : 'Add tags'}
                </button>
              </>
            )}
          </div>

          {link.summary ? (
            <p className="mt-5 border-l-2 border-ember/50 pl-3 text-sm text-ink-soft italic">
              {link.summary}
            </p>
          ) : null}

          <div className="mt-6">
            {link.status === 'fetching' ? (
              <p className="text-sm text-ink-soft" data-testid="link-fetching">
                Getting the page…
              </p>
            ) : link.status === 'failed' ? (
              <p className="text-sm text-ink-soft" data-testid="link-failed">
                {link.fetchError ?? 'Couldn’t get the page'}.{' '}
                <button
                  type="button"
                  className="text-ember-strong underline"
                  onClick={() =>
                    act(async () => {
                      const next = await linksApi.refetch(link.space, link.id)
                      setLink({ ...link, ...next })
                    })
                  }
                >
                  Try again
                </button>
              </p>
            ) : (
              (body ?? (
                <p className="text-sm text-ink-soft">
                  There’s no readable copy of this page.{' '}
                  <a
                    href={webUrl(link.url) ?? undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-ember-strong underline"
                  >
                    Open the original
                  </a>
                  .
                </p>
              ))
            )}
          </div>
        </article>
      </div>
    </>
  )
}
