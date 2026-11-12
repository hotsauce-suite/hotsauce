// MSW routes for People (ARCHITECTURE §17). Like the server, they work people out from the
// meetings and calendar the member can see (asking the other mock routes), and keep About notes
// in memory.

import { type AnyHandler, HttpResponse, http } from 'msw'
import type { CompanyView, MeetingRef, PersonSummary, PersonView } from '../api/people'
import type { CalendarEvent, MeetingSummary } from '../api/types'

const PERSONAL = new Set(['gmail.com', 'outlook.com', 'icloud.com', 'yahoo.com', 'hotmail.com'])
const OURS = new Set(['example.test'])

interface Acc {
  email: string
  name: string | null
  history: MeetingRef[]
  next: { title: string; start: string } | null
}

function emailOf(attendee: string): { email: string; name: string | null } | null {
  const m = /^\s*(.*?)\s*<([^<>]*)>\s*$/.exec(attendee)
  const email = (m?.[2] ?? attendee).trim().toLowerCase()
  return email.includes('@') ? { email, name: m?.[1]?.trim() || null } : null
}

const summary = (a: Acc): PersonSummary => {
  const domain = a.email.slice(a.email.indexOf('@') + 1)
  return {
    email: a.email,
    name: a.name,
    company: PERSONAL.has(domain) ? null : domain,
    team: OURS.has(domain),
    meetings: a.history.length,
    last: a.history[0] ?? null,
    next: a.next,
  }
}

export function peopleHandlers(): AnyHandler[] {
  const about = new Map<string, { text: string; blobOid: string }>()
  let version = 0

  async function gather(request: Request): Promise<Map<string, Acc> | Response> {
    const url = new URL(request.url)
    const ask = (path: string) =>
      fetch(new URL(path, url.origin), { headers: request.headers }).then(async (r) => ({
        ok: r.ok,
        status: r.status,
        body: await r.json(),
      }))
    const meetings = await ask('/api/meetings')
    if (!meetings.ok) return HttpResponse.json(meetings.body, { status: meetings.status })
    const me = await ask('/api/me')
    const self = String(me.body?.principal?.email ?? '').toLowerCase()
    const people = new Map<string, Acc>()
    const acc = (email: string) => {
      if (email === self) return null
      let a = people.get(email)
      if (!a) {
        a = { email, name: null, history: [], next: null }
        people.set(email, a)
      }
      return a
    }
    for (const m of meetings.body as MeetingSummary[]) {
      for (const attendee of m.attendees ?? []) {
        const who = emailOf(attendee)
        const a = who && acc(who.email)
        if (!a) continue
        a.name ??= who.name
        a.history.push({ space: m.space, path: m.path, title: m.title, date: m.date })
      }
    }
    const now = Date.now()
    const calendar = await ask(
      `/api/calendar/upcoming?from=${encodeURIComponent(new Date(now).toISOString())}&to=${encodeURIComponent(new Date(now + 60 * 86_400_000).toISOString())}`,
    )
    if (calendar.ok && Array.isArray(calendar.body)) {
      for (const ev of calendar.body as CalendarEvent[]) {
        for (const att of ev.attendees) {
          const a = acc(att.email.toLowerCase())
          if (!a) continue
          if (att.name) a.name ??= att.name
          a.next ??= { title: ev.title, start: ev.start }
        }
      }
    }
    return people
  }

  return [
    http.get('/api/people', async ({ request }) => {
      const people = await gather(request)
      if (people instanceof Response) return people
      const q = new URL(request.url).searchParams.get('q')?.trim().toLowerCase() ?? ''
      const list = [...people.values()]
        .map(summary)
        .filter(
          (p) => !q || `${p.email} ${p.name ?? ''} ${p.company ?? ''}`.toLowerCase().includes(q),
        )
        .sort(
          (a, b) =>
            (b.last ? Date.parse(b.last.date) : -1) - (a.last ? Date.parse(a.last.date) : -1) ||
            a.email.localeCompare(b.email),
        )
      return HttpResponse.json({ people: list })
    }),
    http.get('/api/people/:email', async ({ request, params }) => {
      const people = await gather(request)
      if (people instanceof Response) return people
      const email = decodeURIComponent(String(params.email)).toLowerCase()
      const a = people.get(email)
      if (!a) {
        return HttpResponse.json(
          { error: { code: 'not_found', message: `No one called ${email}` } },
          { status: 404 },
        )
      }
      const view: PersonView = {
        ...summary(a),
        history: a.history,
        tasks: [],
        about: about.get(email) ?? { text: '', blobOid: null },
        canEditAbout: a.history.length > 0,
      }
      return HttpResponse.json(view)
    }),
    http.put('/api/people/:email/about', async ({ request, params }) => {
      const email = decodeURIComponent(String(params.email)).toLowerCase()
      const body = (await request.json()) as { text: string; blobOid: string | null }
      const current = about.get(email)
      if ((current?.blobOid ?? null) !== body.blobOid) {
        return HttpResponse.json(
          { error: { code: 'conflict', message: 'Someone changed this meanwhile' } },
          { status: 409 },
        )
      }
      const blobOid = `about-${++version}`
      about.set(email, { text: body.text.replace(/\s+$/, ''), blobOid })
      return HttpResponse.json({ blobOid })
    }),
    http.get('/api/companies/:domain', async ({ request, params }) => {
      const people = await gather(request)
      if (people instanceof Response) return people
      const domain = String(params.domain).toLowerCase()
      const ofCompany = [...people.values()].filter((a) => a.email.endsWith(`@${domain}`))
      if (ofCompany.length === 0 || PERSONAL.has(domain)) {
        return HttpResponse.json(
          { error: { code: 'not_found', message: `No company ${domain}` } },
          { status: 404 },
        )
      }
      const seen = new Set<string>()
      const view: CompanyView = {
        domain,
        team: OURS.has(domain),
        people: ofCompany.map(summary),
        meetings: ofCompany
          .flatMap((a) => a.history)
          .filter((m) => !seen.has(m.path) && Boolean(seen.add(m.path))),
      }
      return HttpResponse.json(view)
    }),
  ]
}
