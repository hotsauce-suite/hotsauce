// MSW routes for `/api/links` (ARCHITECTURE §23.4), in memory, so Links works in the live demo
// (docs/PLAN-links-demo.md). Pages aren't visited: a new link reads a stand-in copy after a short
// "fetching" pause, and "Get the page" on a waiting link brings back the copy its seed holds.

import { docPath, highlightsDoc, linkPath, newDoc } from '@hotsauce/format'
import { type AnyHandler, delay, HttpResponse, http } from 'msw'
import type {
  HighlightInput,
  HighlightView,
  LinkHighlight,
  LinkView,
  LinkWithBody,
  ReadingPlace,
} from '../api/links'
import type { FakeRepo, FakeUser } from './fakeRepo'
import type { FakeFiles } from './fileHandlers'
import { demoCopy, type SeedLink, seedLinks, textPdf } from './linkSeed'
import { ADA, PRIYA, SAM, seedId } from './seed'

const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const NAMES = new Map([ADA, PRIYA, SAM].map((a) => [a.email, a.name]))
const nameOf = (email: string) =>
  NAMES.get(email) ?? (email.split('@')[0] ?? email).replace(/^./, (c) => c.toUpperCase())
const wordsIn = (text: string) => text.split(/\s+/).filter(Boolean).length || null

/** The top-level block of the copy a passage starts in, as the reader counts them. */
function blockOf(body: string, quote: string): number | undefined {
  const blocks = body.split(/\n{2,}/)
  const i = blocks.findIndex((b) => b.includes(quote))
  return i < 0 ? undefined : i
}

type Stored = Omit<LinkView, 'reading' | 'highlightCount'> & {
  body: string
  later: string
  highlights: Array<Omit<LinkHighlight, 'name'>>
}

export class FakeLinks {
  readonly links = new Map<string, Stored>()
  /** Each member's place, by link id then email. */
  readonly places = new Map<string, Map<string, ReadingPlace>>()
  #seq = 0

  key(space: string, id: string): string {
    return `${space}/${id}`
  }

  get(space: string, id: string): Stored | undefined {
    return this.links.get(this.key(space, id))
  }

  nextId(tag = 'SAVEDNEW'): string {
    return seedId(tag, ++this.#seq)
  }

  add(link: Stored): Stored {
    this.links.set(this.key(link.space, link.id), link)
    return link
  }

  place(id: string, email: string): ReadingPlace | null {
    return this.places.get(id)?.get(email) ?? null
  }

  setPlace(id: string, email: string, place: ReadingPlace): void {
    let byEmail = this.places.get(id)
    if (!byEmail) {
      byEmail = new Map()
      this.places.set(id, byEmail)
    }
    byEmail.set(email, place)
  }

  view(link: Stored, email: string): LinkView {
    const { body: _b, later: _l, highlights, ...rest } = link
    return { ...rest, reading: this.place(link.id, email), highlightCount: highlights.length }
  }

  withBody(link: Stored, email: string): LinkWithBody {
    return {
      ...this.view(link, email),
      body: link.body,
      highlights: link.highlights.map((h) => ({ ...h, name: nameOf(h.by) })),
    }
  }
}

/** The demo's links, with their PDFs added to Files. */
export function seedFakeLinks(links: FakeLinks, files: FakeFiles, now = Date.now()): void {
  const people = { ada: ADA.email, priya: PRIYA.email, sam: SAM.email }
  for (const s of seedLinks(people)) {
    const id = seedId('SAVED', s.n)
    const saved = now - s.daysAgo * DAY
    const file = s.pdf
      ? files.add({
          id: seedId('FPDF', s.n),
          space: s.space,
          folder: 'Links',
          name: s.pdf.name,
          bytes: textPdf(s.pdf.title, s.pdf.lines),
          mime: 'application/pdf',
          by: s.savedBy,
          at: saved,
          text: s.pdf.lines.join('\n'),
        }).id
      : null
    links.add(stored(s, id, saved, file))
    if (s.reading) {
      const { daysAgo, ...place } = s.reading
      links.setPlace(id, people.ada, { ...place, updated: iso(now - daysAgo * DAY) })
    }
  }
}

function stored(s: SeedLink, id: string, saved: number, file: string | null): Stored {
  const waiting = s.status === 'waiting'
  return {
    space: s.space,
    path: linkPath(id),
    id,
    blobOid: `blob-${id}`,
    url: s.url,
    title: s.title,
    site: s.site,
    description: s.description,
    summary: s.summary,
    tags: s.tags,
    archived: s.archived ?? false,
    saved: iso(saved),
    savedBy: s.savedBy,
    fetched: waiting ? null : iso(saved + 4000),
    fetchError: null,
    words: wordsIn(s.body),
    source: s.source,
    status: s.status ?? 'ready',
    file,
    paper: s.paper ?? null,
    body: s.body,
    later: s.later ?? '',
    highlights: (s.highlights ?? []).map(({ daysAgo, ...h }, i) => {
      const block = blockOf(s.body, h.quote)
      return {
        ...h,
        id: seedId('HGT', s.n * 10 + i),
        at: iso(saved + (s.daysAgo - daysAgo) * DAY + (i + 1) * 60_000),
        ...(block === undefined ? {} : { block }),
      }
    }),
  }
}

export interface LinkHandlerDeps {
  links: FakeLinks
  files: FakeFiles
  repo: FakeRepo
  latencyMs: number
  principal: (request: Request) => FakeUser | Response
}

const error = (status: number, code: string, message: string) =>
  HttpResponse.json({ error: { code, message } }, { status })

/** How long a new or refetched link stays "fetching" in the demo. */
const FETCH_MS = 1200

export function linkHandlers(deps: LinkHandlerDeps): AnyHandler[] {
  const { links, files } = deps
  const wait = () => (deps.latencyMs > 0 ? delay(deps.latencyMs) : Promise.resolve())
  const visible = (user: FakeUser) => (l: Stored) => l.space === 'team' || l.space === user.handle
  const canUse = (user: FakeUser, space: string) => space === 'team' || space === user.handle
  const now = () => iso(Date.now())

  type Ctx = { user: FakeUser; request: Request; params: Record<string, string> }
  const route =
    (resolve: (ctx: Ctx) => Response | Promise<Response>) =>
    async ({ request, params }: { request: Request; params: Record<string, unknown> }) => {
      await wait()
      const user = deps.principal(request)
      if (user instanceof Response) return user
      return resolve({ user, request, params: params as Record<string, string> })
    }
  /** A route on one link the member can see. */
  const linkRoute = (resolve: (ctx: Ctx & { link: Stored }) => Response | Promise<Response>) =>
    route((ctx) => {
      const { space = '', id = '' } = ctx.params
      if (!canUse(ctx.user, space)) return error(403, 'forbidden', 'You can’t see this space')
      const link = links.get(space, id)
      if (!link) return error(404, 'not_found', 'This link isn’t saved anymore')
      return resolve({ ...ctx, link })
    })

  /** Turns a link "fetching", then ready with its copy, like the server's background fetch. */
  const fetchLater = (link: Stored, copy: string) => {
    link.status = 'fetching'
    link.fetchError = null
    setTimeout(() => {
      link.status = 'ready'
      link.body = copy
      link.words = wordsIn(copy)
      link.fetched = now()
      link.blobOid = `blob-${link.id}-${Date.now()}`
    }, FETCH_MS)
  }

  const pdfFile = (space: string, id: string) => {
    const file = files.get(space, id)
    return file?.mime === 'application/pdf' ? file : null
  }

  return [
    http.get(
      '/api/links',
      route(({ user, request }) => {
        const url = new URL(request.url)
        const view = url.searchParams.get('view') ?? 'unread'
        const tag = url.searchParams.get('tag')?.toLowerCase()
        const words = (url.searchParams.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean)
        const list = [...links.links.values()]
          .filter(visible(user))
          .filter((l) => view === 'all' || l.archived === (view === 'archive'))
          .filter((l) => !tag || l.tags.some((t) => t.toLowerCase() === tag))
          .filter((l) => {
            if (words.length === 0) return true
            const hay = [l.title, l.site, l.url, l.summary, l.body, ...l.tags]
              .join('\n')
              .toLowerCase()
            return words.every((w) => hay.includes(w))
          })
          .sort((a, b) => b.saved.localeCompare(a.saved) || b.id.localeCompare(a.id))
          .map((l) => links.view(l, user.email))
        return HttpResponse.json({ links: list })
      }),
    ),

    http.get(
      '/api/links/tags',
      route(({ user }) => {
        const counts = new Map<string, number>()
        for (const l of [...links.links.values()].filter(visible(user))) {
          for (const t of l.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
        }
        return HttpResponse.json(
          [...counts.entries()]
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        )
      }),
    ),

    http.get(
      '/api/links/highlights',
      route(({ user, request }) => {
        const words = (new URL(request.url).searchParams.get('q') ?? '')
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean)
        const out: HighlightView[] = []
        for (const l of [...links.links.values()].filter(visible(user))) {
          const link = { space: l.space, id: l.id, title: l.title, site: l.site, url: l.url }
          for (const h of l.highlights) {
            const hay = `${h.quote}\n${h.note ?? ''}\n${l.title}`.toLowerCase()
            if (words.length > 0 && !words.every((w) => hay.includes(w))) continue
            out.push({ ...h, name: nameOf(h.by), link })
          }
        }
        out.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
        return HttpResponse.json({ highlights: out })
      }),
    ),

    http.post(
      '/api/links',
      route(async ({ user, request }) => {
        const body = (await request.json()) as {
          url?: string
          text?: string
          title?: string
          tags?: string[]
          space?: string
          source?: LinkView['source']
        }
        const found = [body.url, body.text, body.title]
          .map((s) => s?.match(/https?:\/\/[^\s<>"]+/i)?.[0])
          .find(Boolean)
        if (!found) return error(400, 'bad_request', 'There’s no web link in what was shared')
        const space = body.space ?? user.handle
        if (!canUse(user, space)) return error(403, 'forbidden', 'You can’t see this space')
        // An address already saved anywhere you can see comes back to Unread, as on the server.
        const same = [...links.links.values()]
          .filter(visible(user))
          .find((l) => l.url.replace(/\/+$/, '') === found.replace(/\/+$/, ''))
        if (same) {
          same.archived = false
          return HttpResponse.json({ ...links.view(same, user.email), existing: true })
        }
        const id = links.nextId()
        let host = found
        try {
          host = new URL(found).hostname.replace(/^www\./, '')
        } catch {}
        const link = links.add({
          space,
          path: linkPath(id),
          id,
          blobOid: `blob-${id}`,
          url: found,
          title: body.title?.trim() || host,
          site: host,
          description: '',
          summary: '',
          tags: body.tags ?? [],
          archived: false,
          saved: now(),
          savedBy: user.email,
          fetched: null,
          fetchError: null,
          words: null,
          source: body.source ?? null,
          status: 'fetching',
          file: null,
          paper: null,
          body: '',
          later: '',
          highlights: [],
        })
        fetchLater(link, demoCopy(found))
        return HttpResponse.json(
          { ...links.view(link, user.email), existing: false },
          { status: 201 },
        )
      }),
    ),

    http.post(
      '/api/links/pdf',
      route(async ({ user, request }) => {
        const { space, file: fileId } = (await request.json()) as { space: string; file: string }
        if (!canUse(user, space)) return error(403, 'forbidden', 'You can’t see this space')
        const file = pdfFile(space, fileId)
        if (!file) return error(400, 'bad_request', 'That file isn’t a PDF')
        const same = [...links.links.values()].find((l) => l.space === space && l.file === file.id)
        if (same) return HttpResponse.json({ ...links.view(same, user.email), existing: true })
        const id = links.nextId()
        const text = file.text || 'The live demo doesn’t read the text of PDFs you add.'
        const link = links.add({
          space,
          path: linkPath(id),
          id,
          blobOid: `blob-${id}`,
          url: '',
          title: file.name.replace(/\.pdf$/i, ''),
          site: '',
          description: '',
          summary: '',
          tags: [],
          archived: false,
          saved: now(),
          savedBy: user.email,
          fetched: null,
          fetchError: null,
          words: null,
          source: 'web',
          status: 'fetching',
          file: file.id,
          paper: null,
          body: '',
          later: '',
          highlights: [],
        })
        fetchLater(link, text)
        return HttpResponse.json(
          { ...links.view(link, user.email), existing: false },
          { status: 201 },
        )
      }),
    ),

    http.post(
      '/api/links/:space/:id/pdf',
      linkRoute(async ({ user, request, link }) => {
        const { file: fileId } = (await request.json()) as { file: string }
        if (link.file) return error(409, 'conflict', 'This link already has its PDF')
        const file = pdfFile(link.space, fileId)
        if (!file) return error(400, 'bad_request', 'That file isn’t a PDF')
        link.file = file.id
        // The added PDF is the copy when the site gave no text, as on the server.
        if (!link.body) fetchLater(link, file.text || demoCopy(link.url))
        return HttpResponse.json(links.view(link, user.email))
      }),
    ),

    http.get(
      '/api/links/:space/:id',
      linkRoute(({ user, link }) => HttpResponse.json(links.withBody(link, user.email))),
    ),

    http.patch(
      '/api/links/:space/:id',
      linkRoute(async ({ user, request, link }) => {
        const patch = (await request.json()) as {
          title?: string
          tags?: string[]
          archived?: boolean
        }
        if (patch.title !== undefined) link.title = patch.title
        if (patch.tags !== undefined) link.tags = patch.tags
        if (patch.archived !== undefined) link.archived = patch.archived
        link.blobOid = `blob-${link.id}-${Date.now()}`
        return HttpResponse.json(links.view(link, user.email))
      }),
    ),

    http.put(
      '/api/links/:space/:id/reading',
      linkRoute(async ({ user, request, link }) => {
        const { anchor, percent } = (await request.json()) as { anchor: number; percent: number }
        const before = links.place(link.id, user.email)
        links.setPlace(link.id, user.email, {
          anchor,
          percent,
          furthest: Math.max(before?.furthest ?? 0, percent),
          updated: now(),
        })
        return new HttpResponse(null, { status: 204 })
      }),
    ),

    http.post(
      '/api/links/:space/:id/refetch',
      linkRoute(({ user, link }) => {
        const kept = link.file ? files.get(link.space, link.file)?.text : ''
        fetchLater(link, link.later || link.body || kept || demoCopy(link.url))
        return HttpResponse.json(links.view(link, user.email))
      }),
    ),

    http.post(
      '/api/links/:space/:id/move',
      linkRoute(async ({ user, request, link }) => {
        const { toSpace } = (await request.json()) as { toSpace: string }
        if (!canUse(user, toSpace)) return error(403, 'forbidden', 'You can’t see this space')
        if (link.space === 'team' && toSpace !== 'team' && link.savedBy !== user.email) {
          return error(
            403,
            'forbidden',
            'Only the person who saved a team link can make it private',
          )
        }
        // The link's PDF goes with it, as on the server.
        const pdf = link.file ? files.get(link.space, link.file) : undefined
        if (pdf) {
          files.files.delete(files.key(pdf.space, pdf.id))
          pdf.space = toSpace
          files.files.set(files.key(pdf.space, pdf.id), pdf)
        }
        links.links.delete(links.key(link.space, link.id))
        link.space = toSpace
        links.add(link)
        return HttpResponse.json(links.view(link, user.email))
      }),
    ),

    http.post(
      '/api/links/:space/:id/highlights',
      linkRoute(async ({ user, request, link }) => {
        const input = (await request.json()) as HighlightInput
        const h = { ...input, id: links.nextId('HGTNEW'), by: user.email, at: now() }
        link.highlights.push(h)
        return HttpResponse.json({ ...h, name: user.name }, { status: 201 })
      }),
    ),

    http.post(
      '/api/links/:space/:id/highlights/doc',
      linkRoute(({ user, link }) => {
        if (link.highlights.length === 0) {
          return error(409, 'conflict', 'This link has no highlights to copy')
        }
        const doc = highlightsDoc({
          title: link.title || link.site || link.url,
          url: link.url,
          appUrl: `${window.location.origin}/links/${encodeURIComponent(link.space)}/${encodeURIComponent(link.id)}`,
          highlights: link.highlights,
          me: user.email,
          nameOf,
        })
        const fresh = newDoc(doc.title)
        const text = fresh.text.replace(/\n# [^\n]*\n\n$/, () => `\n${doc.markdown}`)
        const personal = deps.repo.space(user.handle)
        const stem = docPath('', doc.title).replace(/\.md$/, '')
        let path = `${stem}.md`
        for (let n = 2; personal.files.has(path); n++) path = `${stem}-${n}.md`
        personal.commit(
          new Map([[path, text]]),
          { name: user.name, email: user.email },
          `docs: copy "${doc.title}"`,
        )
        return HttpResponse.json({ space: user.handle, path, title: doc.title }, { status: 201 })
      }),
    ),

    http.patch(
      '/api/links/:space/:id/highlights/:hid',
      linkRoute(async ({ user, request, params, link }) => {
        const h = link.highlights.find((x) => x.id === params.hid)
        if (!h) return error(404, 'not_found', 'This highlight isn’t there anymore')
        if (h.by !== user.email) return error(403, 'forbidden', 'Only its maker can change a note')
        const { note } = (await request.json()) as { note: string }
        if (note.trim()) h.note = note
        else delete h.note
        h.edited = now()
        return HttpResponse.json({ ...h, name: nameOf(h.by) })
      }),
    ),

    http.delete(
      '/api/links/:space/:id/highlights/:hid',
      linkRoute(({ user, params, link }) => {
        const h = link.highlights.find((x) => x.id === params.hid)
        if (!h) return error(404, 'not_found', 'This highlight isn’t there anymore')
        if (h.by !== user.email) return error(403, 'forbidden', 'Only its maker can remove it')
        link.highlights = link.highlights.filter((x) => x.id !== h.id)
        return new HttpResponse(null, { status: 204 })
      }),
    ),

    http.delete(
      '/api/links/:space/:id',
      linkRoute(({ link }) => {
        // Deleting a link deletes its PDF too (help: Links).
        if (link.file) files.files.delete(files.key(link.space, link.file))
        links.links.delete(links.key(link.space, link.id))
        return new HttpResponse(null, { status: 204 })
      }),
    ),
  ]
}
