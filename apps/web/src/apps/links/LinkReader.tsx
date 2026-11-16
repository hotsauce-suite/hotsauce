import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Markdown, { type Components } from 'react-markdown'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import remarkGfm from 'remark-gfm'
import {
  authorLine,
  highlightLabel,
  type LinkWithBody,
  linkKindLabel,
  linksApi,
  readingTime,
  webUrl,
} from '../../api/links'
import { product } from '../../brand/product'
import { Icon } from '../../components/Icon'
import { inputClass } from '../../routes/org/fields'
import { useSession } from '../../state/session'
import { MeetingsPageHeader, primaryButton, secondaryButton } from '../meetings/components/common'
import { attachPdf, pdfProblem } from './pdfUpload'
import { useHighlights } from './useHighlights'
import { errorMessage, savedDay, useLinksChanged, usePollWhile } from './useLinks'
import { useReadingPlace } from './useReadingPlace'

/** A readable copy shorter than this is offered a fresh read: the page may not have come through. */
const SHORT_COPY_WORDS = 150

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
  const [params] = useSearchParams()
  const goTo = params.get('highlight')
  const { me, spaces, spaceLabel, notify } = useSession()
  const [link, setLink] = useState<LinkWithBody | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editingTags, setEditingTags] = useState(false)
  const [tagText, setTagText] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const pdfInput = useRef<HTMLInputElement>(null)

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
        <div className="prose-hotsauce !p-0" data-testid="link-body" ref={bodyRef}>
          <Markdown remarkPlugins={[remarkGfm]} components={components}>
            {link.body}
          </Markdown>
        </div>
      ) : null,
    [link?.body],
  )

  const ready = !!link && link.status === 'ready' && !!link.body
  const { resumed, startOver } = useReadingPlace({
    space,
    id,
    // Opened at a highlight: go there, not back to the last place.
    saved: goTo ? null : (link?.reading ?? null),
    ready,
    scroller,
    body: bodyRef,
  })
  const myEmail = me?.principal.email.toLowerCase() ?? ''
  const highlights = useHighlights({
    link,
    setLink: (update) => setLink((cur) => (cur ? update(cur) : cur)),
    me: myEmail,
    body: bodyRef,
    scroller,
    ready,
    goTo,
    notify,
  })
  const myHighlights = link?.highlights.filter((h) => h.by === myEmail).length ?? 0

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

  const doneButton = (testId: string) => (
    <button
      type="button"
      data-testid={testId}
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
  )

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
      {resumed ? (
        <p
          className="mx-auto mt-2 flex w-full max-w-2xl flex-wrap items-center gap-x-2 rounded-lg bg-ash/50 px-4 py-2 text-sm text-ink-soft md:px-8"
          data-testid="link-resumed"
        >
          Picked up where you left off.
          <button
            type="button"
            className="text-ember-strong underline"
            data-testid="link-start-over"
            onClick={startOver}
          >
            Start from the top
          </button>
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto" ref={scroller} data-testid="link-scroller">
        <article className="mx-auto w-full max-w-2xl px-4 pt-6 pb-24 md:px-8">
          <h1
            className="font-display text-2xl font-semibold tracking-tight text-ink"
            data-testid="link-reader-title"
          >
            {link.title || link.url || 'Untitled PDF'}
          </h1>
          {link.paper ? (
            <p className="mt-1 text-sm text-ink-soft" data-testid="link-paper">
              {[
                authorLine(link.paper.authors),
                link.paper.published,
                `${linkKindLabel(link)}${link.paper.version ? ` v${link.paper.version}` : ''}`,
              ]
                .filter(Boolean)
                .join(' · ')}
              {link.paper.doi ? (
                <>
                  {' · '}
                  <a
                    href={`https://doi.org/${link.paper.doi}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline"
                  >
                    doi:{link.paper.doi}
                  </a>
                </>
              ) : null}
            </p>
          ) : null}
          <p className="mt-1 text-sm text-ink-faint">
            {link.url ? (
              <a
                href={webUrl(link.url) ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                className="text-ember-strong hover:underline"
                data-testid="link-original"
              >
                {link.site || 'Open the original'}{' '}
                <Icon name="external" className="inline size-3" />
              </a>
            ) : (
              'A PDF from your computer'
            )}
            {' · '}
            {[readingTime(link.words), `saved ${savedDay(link.saved)}`, spaceLabel(link.space)]
              .filter(Boolean)
              .join(' · ')}
            {link.highlights.length > 0 ? (
              <>
                {' · '}
                <button
                  type="button"
                  className="underline hover:text-ink"
                  data-testid="link-jump-highlights"
                  onClick={() =>
                    document
                      .querySelector('[data-testid="link-highlights"]')
                      ?.scrollIntoView({ block: 'start' })
                  }
                >
                  {highlightLabel(link.highlights.length)}
                </button>
              </>
            ) : null}
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            {doneButton('link-reader-done')}
            {link.file ? (
              <Link
                to={`/files/${encodeURIComponent(link.space)}/${encodeURIComponent(link.file)}`}
                className={secondaryButton}
                data-testid="link-open-pdf"
              >
                <Icon name="file" />
                Open PDF
              </Link>
            ) : link.paper && link.status === 'ready' ? (
              <>
                <button
                  type="button"
                  className={secondaryButton}
                  data-testid="link-add-pdf"
                  disabled={busy}
                  title={`${linkKindLabel(link)} only gives its PDF to a browser: download it there, then add it here`}
                  onClick={() => pdfInput.current?.click()}
                >
                  <Icon name="upload" />
                  Add the PDF
                </button>
                <input
                  ref={pdfInput}
                  type="file"
                  accept="application/pdf,.pdf"
                  hidden
                  data-testid="link-pdf-input"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    e.target.value = ''
                    if (!file) return
                    const problem = pdfProblem(file)
                    if (problem) {
                      notify(problem)
                      return
                    }
                    void act(async () => {
                      await attachPdf(file, link)
                      load()
                    }, 'PDF added')
                  }}
                />
              </>
            ) : null}
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
                {myHighlights > 0
                  ? `Share with team (with your ${highlightLabel(myHighlights)})`
                  : 'Share with team'}
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

          {link.paper?.abstract ? (
            <section className="mt-5 border-l-2 border-ember/50 pl-3" data-testid="link-abstract">
              <h2 className="text-xs font-semibold tracking-wide text-ink-faint uppercase">
                Abstract
              </h2>
              <p className="mt-1 text-sm text-ink-soft">{link.paper.abstract}</p>
            </section>
          ) : link.summary ? (
            <p className="mt-5 border-l-2 border-ember/50 pl-3 text-sm text-ink-soft italic">
              {link.summary}
            </p>
          ) : null}

          <div className="mt-6">
            {link.status === 'waiting' ? (
              <div
                className="rounded-xl border border-ash-strong p-4 text-sm text-ink-soft"
                data-testid="link-waiting"
              >
                <p className="font-medium text-ink">An AI tool saved this link.</p>
                <p className="mt-1">
                  {product()} hasn’t visited it yet, so a tool can’t use the address to send your
                  text somewhere. Check the address first:
                </p>
                <p className="mt-2 font-mono text-xs break-all text-ink" data-testid="link-address">
                  {link.url}
                </p>
                <button
                  type="button"
                  className="mt-3 rounded-lg bg-ember px-3.5 py-2 text-sm font-medium text-paper-raised hover:bg-ember-strong"
                  onClick={() =>
                    act(async () => {
                      const next = await linksApi.refetch(link.space, link.id)
                      setLink({ ...link, ...next })
                    })
                  }
                >
                  Get the page
                </button>
              </div>
            ) : link.status === 'fetching' ? (
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
            ) : body ? (
              <>
                {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: a click on a highlighted passage opens it; the Highlights list above does the same by keyboard */}
                <div onClick={highlights.onBodyClick}>{body}</div>
                {ready && link.highlights.length === 0 ? (
                  <p className="sr-only">
                    Select words in the page to highlight them or add a note.
                  </p>
                ) : null}
                {link.words != null &&
                link.words < SHORT_COPY_WORDS &&
                !link.file &&
                !link.paper ? (
                  <p className="mt-6 text-sm text-ink-soft" data-testid="link-short">
                    Only part of the page may have come through.{' '}
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
                      Get the page again
                    </button>
                  </p>
                ) : null}
                {highlights.section}
                <div className="mt-10 flex justify-center border-t border-ash/70 pt-6">
                  {doneButton('link-end-done')}
                </div>
              </>
            ) : link.file ? (
              <p className="text-sm text-ink-soft" data-testid="link-no-text">
                This PDF has no text to read (it may be scanned).{' '}
                <Link
                  to={`/files/${encodeURIComponent(link.space)}/${encodeURIComponent(link.file)}`}
                  className="text-ember-strong underline"
                >
                  Open PDF
                </Link>
                .
              </p>
            ) : link.paper ? (
              <p className="text-sm text-ink-soft" data-testid="link-details-only">
                Only the paper’s details came through, not its text.{' '}
                <a
                  href={webUrl(link.url) ?? undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-ember-strong underline"
                >
                  Open it on {linkKindLabel(link)}
                </a>
                , or add its PDF.
              </p>
            ) : (
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
            )}
          </div>
        </article>
      </div>
      {highlights.overlay}
    </>
  )
}
