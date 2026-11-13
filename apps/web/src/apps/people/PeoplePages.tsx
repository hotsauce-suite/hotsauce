// People (ARCHITECTURE §17.5): the list, a person's page and a company's page. Nothing here is
// typed in except a person's About note; everything else comes from meetings, the calendar and
// tasks the member can read.

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { HearthApiError } from '../../api/client'
import {
  type CompanyView,
  companyUrl,
  displayName,
  type MeetingRef,
  type PersonSummary,
  type PersonView,
  peopleApi,
  personUrl,
} from '../../api/people'
import { hearthSocket } from '../../api/ws'
import { product } from '../../brand/product'
import { Icon, type IconName } from '../../components/Icon'
import { useListKeys } from '../../keyboard/listKeys'
import { meetingUrl, taskUrl } from '../../lib/paths'
import { MeetingsPageHeader } from '../meetings/components/common'
import { dayLabel, timeLabel } from '../meetings/format'

const REFRESH_DEBOUNCE_MS = 500
const SEARCH_DEBOUNCE_MS = 150

/**
 * Loads `fetcher`, again when `key` changes and after changes elsewhere; only the newest answer
 * is shown, so a slow older one never replaces a newer one.
 */
function useLive<T>(fetcher: () => Promise<T>, key: string) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<{ status: number; message: string } | null>(null)
  const latest = useRef(0)
  const fetchRef = useRef(fetcher)
  fetchRef.current = fetcher
  const load = useCallback(async () => {
    const ask = ++latest.current
    try {
      const next = await fetchRef.current()
      if (ask !== latest.current) return
      setData(next)
      setError(null)
    } catch (err) {
      if (ask !== latest.current) return
      setError({
        status: err instanceof HearthApiError ? err.status : 0,
        message: err instanceof HearthApiError ? err.message : 'This didn’t load.',
      })
    }
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new key is a new page to load.
  useEffect(() => {
    // The last answer stays up while the next one loads (no flash on each keystroke).
    setError(null)
    void load()
    let timer: ReturnType<typeof setTimeout> | null = null
    const soon = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void load(), REFRESH_DEBOUNCE_MS)
    }
    const offChanged = hearthSocket.onChanged(soon)
    const offReconnect = hearthSocket.onReconnect(soon)
    return () => {
      offChanged()
      offReconnect()
      if (timer) clearTimeout(timer)
    }
  }, [load, key])

  return { data, error, setData, bump: () => latest.current++ }
}

function Page({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <>
      <MeetingsPageHeader title={title} menu={false} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl px-4 pt-6 pb-24 md:px-8">{children}</div>
      </div>
    </>
  )
}

function Card({
  title,
  icon,
  testId,
  children,
}: {
  title: string
  icon: IconName
  testId: string
  children: ReactNode
}) {
  return (
    <section
      data-testid={testId}
      aria-label={title}
      className="rounded-2xl border border-ash bg-paper-raised/60 px-4 py-4 md:px-5"
    >
      <div className="mb-3 flex items-center gap-2">
        <Icon name={icon} className="size-4 text-ink-faint" />
        <h2 className="flex-1 text-sm font-semibold text-ink">{title}</h2>
      </div>
      {children}
    </section>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-ink-faint">{children}</p>
}

function Problem({ error }: { error: { status: number; message: string } | null }) {
  if (!error) return null
  return (
    <p role="alert" className="mb-4 text-sm text-ember-strong">
      {error.status === 404 ? 'No one by that address in anything you can read.' : error.message}
    </p>
  )
}

/** "Today · 3:00 PM", "Mar 4", for a meeting date. */
/** A note's `date`; a bare `YYYY-MM-DD` is that day where the member is, not UTC midnight. */
function parseDate(iso: string): Date | null {
  const bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  const d = bare ? new Date(Number(bare[1]), Number(bare[2]) - 1, Number(bare[3])) : new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

function when(iso: string): string {
  const d = parseDate(iso)
  if (!d) return ''
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? dayLabel(d) : `${dayLabel(d)} · ${timeLabel(d)}`
}

function initials(p: Pick<PersonSummary, 'name' | 'email'>): string {
  const words = (p.name ?? p.email.split('@')[0] ?? '').split(/[\s._-]+/).filter(Boolean)
  return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')).toUpperCase() || '?'
}

function Avatar({ person, size = 'size-9' }: { person: PersonSummary; size?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`${size} inline-flex shrink-0 items-center justify-center rounded-full bg-ember-wash font-medium text-ember-strong text-xs`}
    >
      {initials(person)}
    </span>
  )
}

function CompanyTag({ person }: { person: PersonSummary }) {
  if (person.team) {
    return <span className="rounded-full bg-ash/60 px-2 py-0.5 text-xs text-ink-soft">Team</span>
  }
  if (!person.company) return null
  return (
    <Link
      to={companyUrl(person.company)}
      className="text-xs text-ink-soft underline-offset-2 hover:underline"
      data-testid="person-company"
    >
      {person.company}
    </Link>
  )
}

function MeetingList({ meetings, testId }: { meetings: MeetingRef[]; testId: string }) {
  if (meetings.length === 0) return <Empty>No meeting notes yet.</Empty>
  return (
    <ul className="divide-y divide-ash/60">
      {meetings.map((m) => (
        <li key={`${m.space}\n${m.path}`} data-testid={testId}>
          <Link
            to={meetingUrl(m.space, m.path)}
            className="flex items-baseline gap-3 py-2 text-sm hover:text-ember-strong"
          >
            <span className="min-w-0 flex-1 truncate text-ink">{m.title}</span>
            <span className="shrink-0 text-xs text-ink-faint">{when(m.date)}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

/** `/people`: everyone, most recent meeting first, with a search box. */
export function PeopleList() {
  useListKeys()
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setQuery(q), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [q])
  useEffect(() => {
    document.title = `${product()} People`
  }, [])
  const { data, error } = useLive(() => peopleApi.list(query), query)
  const people = data?.people ?? null

  return (
    <Page title="People">
      <label className="mb-5 flex items-center gap-2 rounded-xl border border-ash bg-paper-raised px-3 py-2">
        <Icon name="search" className="size-4 text-ink-faint" />
        <span className="sr-only">Find a person</span>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Find by name, email or company"
          className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
          data-testid="people-search"
        />
      </label>
      <Problem error={error} />
      {people === null ? (
        error ? null : (
          <p className="text-sm text-ink-faint">Loading people…</p>
        )
      ) : people.length === 0 ? (
        <Empty>
          {query
            ? 'No one matches.'
            : 'People show up here once they’re in a meeting note, on your calendar or assigned a task.'}
        </Empty>
      ) : (
        <ul className="divide-y divide-ash/60" data-testid="people-list">
          {people.map((p) => (
            <li key={p.email} data-testid="people-row" data-email={p.email}>
              <Link
                to={personUrl(p.email)}
                data-list-item
                className="flex items-center gap-3 py-2.5 hover:text-ember-strong"
              >
                <Avatar person={p} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">
                    {displayName(p)}
                  </span>
                  <span className="block truncate text-xs text-ink-faint">
                    {p.name ? `${p.email} · ` : ''}
                    {p.team ? 'Team' : (p.company ?? 'Personal email')}
                  </span>
                </span>
                <span className="hidden shrink-0 text-right text-xs text-ink-soft sm:block">
                  {p.meetings === 1 ? '1 meeting' : `${p.meetings} meetings`}
                  {p.last && parseDate(p.last.date) ? (
                    <span className="block text-ink-faint">
                      Last {dayLabel(parseDate(p.last.date) as Date)}
                    </span>
                  ) : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Page>
  )
}

/** `/people/:email`: who they are, meetings, open tasks and the team's About note. */
export function PersonPage() {
  // useParams has already decoded it.
  const email = useParams().email ?? ''
  const { data: person, error, setData, bump } = useLive(() => peopleApi.get(email), email)
  useEffect(() => {
    document.title = `${person ? displayName(person) : email} · ${product()} People`
  }, [person, email])

  return (
    <Page title={person ? displayName(person) : 'Person'}>
      <Link to="/people" className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft">
        <Icon name="back" className="size-3.5" /> People
      </Link>
      <Problem error={error} />
      {person === null ? (
        error ? null : (
          <p className="text-sm text-ink-faint">Loading…</p>
        )
      ) : (
        <div className="flex flex-col gap-5" data-testid="person-page">
          <div className="flex items-center gap-4">
            <Avatar person={person} size="size-14 text-base" />
            <div className="min-w-0">
              <p className="truncate font-display text-xl font-semibold text-ink">
                {displayName(person)}
              </p>
              <p className="flex flex-wrap items-center gap-x-2 text-sm text-ink-soft">
                <a href={`mailto:${person.email}`} className="truncate hover:underline">
                  {person.email}
                </a>
                <CompanyTag person={person} />
              </p>
            </div>
          </div>
          <div className="grid gap-5 md:grid-cols-[3fr_2fr]">
            <div className="flex min-w-0 flex-col gap-5">
              <About
                person={person}
                onSaved={(about) => {
                  bump()
                  setData((p) => (p ? { ...p, about } : p))
                }}
              />
              <Card title="Meetings" icon="calendar" testId="person-meetings">
                <MeetingList meetings={person.history} testId="person-meeting" />
              </Card>
            </div>
            <div className="flex min-w-0 flex-col gap-5">
              <Card title="Next meeting" icon="today" testId="person-next">
                {person.next ? (
                  <p className="text-sm text-ink">
                    {person.next.title}
                    <span className="block text-xs text-ink-faint">{when(person.next.start)}</span>
                  </p>
                ) : (
                  <Empty>Nothing on your calendar.</Empty>
                )}
              </Card>
              <Card title="Open tasks" icon="tasks" testId="person-tasks">
                {person.tasks.length === 0 ? (
                  <Empty>None assigned to them.</Empty>
                ) : (
                  <ul className="flex flex-col gap-1.5">
                    {person.tasks.map((t) => (
                      <li key={`${t.space}/${t.id}`}>
                        <Link
                          to={taskUrl(t.space, t.path)}
                          className="text-sm text-ink hover:text-ember-strong"
                        >
                          {t.title}
                        </Link>
                        {t.due ? (
                          <span className="ml-2 text-xs text-ink-faint">
                            due {t.due.slice(0, 10)}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </div>
        </div>
      )}
    </Page>
  )
}

/** The team's note on someone: edited in place, saved as `people/<email>.md` in the team space. */
function About({
  person,
  onSaved,
}: {
  person: PersonView
  onSaved: (about: PersonView['about']) => void
}) {
  // The version being edited is the one shown when editing began: a reload from someone else's
  // save mustn't swap it, or this save would overwrite theirs instead of being refused.
  const [draft, setDraft] = useState<string | null>(null)
  const [base, setBase] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const editing = draft !== null

  const save = async () => {
    if (draft === null) return
    setSaving(true)
    setProblem(null)
    try {
      const { blobOid } = await peopleApi.saveAbout(person.email, draft, base)
      onSaved({ text: draft.replace(/\s+$/, ''), blobOid })
      setDraft(null)
    } catch (err) {
      setProblem(
        err instanceof HearthApiError && err.status === 409
          ? 'Someone else changed this note. Copy your text, reload, and try again.'
          : err instanceof HearthApiError
            ? err.message
            : 'Didn’t save. Try again.',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card title="About" icon="notes" testId="person-about">
      {editing ? (
        <div className="flex flex-col gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={5}
            aria-label={`About ${displayName(person)}`}
            className="w-full rounded-lg border border-ash bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-ember"
            data-testid="person-about-input"
            // biome-ignore lint/a11y/noAutofocus: the member just asked to edit this.
            autoFocus
          />
          {problem ? (
            <p role="alert" className="text-sm text-ember-strong">
              {problem}
            </p>
          ) : null}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="h-8 rounded-lg bg-ember px-3 text-sm font-medium text-paper-raised hover:bg-ember-strong disabled:opacity-60"
              data-testid="person-about-save"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(null)
                setProblem(null)
              }}
              className="h-8 rounded-lg px-3 text-sm text-ink-soft hover:bg-ash/50"
            >
              Cancel
            </button>
          </div>
          <p className="text-xs text-ink-faint">Everyone on the team can read and edit this.</p>
        </div>
      ) : !person.canEditAbout ? (
        <p className="text-sm text-ink-faint" data-testid="person-about-private">
          {person.about.text ? (
            <span className="whitespace-pre-wrap text-ink" data-testid="person-about-text">
              {person.about.text}
            </span>
          ) : (
            'They’re only in your own meetings or calendar so far, so there’s no team note to write yet.'
          )}
        </p>
      ) : (
        <button
          type="button"
          onClick={() => {
            setBase(person.about.blobOid)
            setDraft(person.about.text)
          }}
          className="block w-full rounded-lg text-left text-sm hover:bg-ash/30"
          data-testid="person-about-edit"
        >
          {person.about.text ? (
            <span className="whitespace-pre-wrap text-ink" data-testid="person-about-text">
              {person.about.text}
            </span>
          ) : (
            <span className="text-ink-faint">
              Add a note: their role, what they care about, how they like to work.
            </span>
          )}
        </button>
      )}
    </Card>
  )
}

/** `/people/company/:domain`: a company's people and meetings. */
export function CompanyPage() {
  const domain = useParams().domain ?? ''
  const { data, error } = useLive(() => peopleApi.company(domain), domain)
  useEffect(() => {
    document.title = `${domain} · ${product()} People`
  }, [domain])
  const company: CompanyView | null = data

  return (
    <Page title={domain}>
      <Link to="/people" className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft">
        <Icon name="back" className="size-3.5" /> People
      </Link>
      {error ? (
        <p role="alert" className="mb-4 text-sm text-ember-strong">
          {error.status === 404
            ? 'No one from that company in anything you can read.'
            : error.message}
        </p>
      ) : null}
      {company === null ? null : (
        <div className="grid gap-5 md:grid-cols-2" data-testid="company-page">
          <Card title="People" icon="people" testId="company-people">
            <ul className="flex flex-col gap-2">
              {company.people.map((p) => (
                <li key={p.email}>
                  <Link
                    to={personUrl(p.email)}
                    className="flex items-center gap-3 hover:text-ember-strong"
                  >
                    <Avatar person={p} size="size-7" />
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">
                      {displayName(p)}
                    </span>
                    <span className="text-xs text-ink-faint">{p.meetings}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Meetings" icon="calendar" testId="company-meetings">
            <MeetingList meetings={company.meetings} testId="company-meeting" />
          </Card>
        </div>
      )}
    </Page>
  )
}
