// MSW routes for `/api/notes` (ARCHITECTURE §14.3), in memory, shaped like the server's NoteView
// (§14.2). Checklist parsing and the Keep mapping are the real ones from @hearth/format.

import {
  cleanLabels,
  isChecklist,
  type KeepNote,
  mapKeepNote,
  NOTE_COLORS,
  newId,
  noteTextOf,
  noteTitle,
} from '@hearth/format'
import { type AnyHandler, delay, HttpResponse, http } from 'msw'
import type { NoteInput, NoteView } from '../api/notes'
import type { ServerEvent } from '../api/types'
import type { FakeUser } from './fakeRepo'
import { SAM } from './seed'

const error = (status: number, code: string, message: string) =>
  HttpResponse.json({ error: { code, message } }, { status })

const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

export class FakeNotes {
  readonly notes = new Map<string, NoteView>()
  readonly seeded = new Set<string>()
  /** Text of every version handed out, by blob id, for the 409 check. */
  readonly versions = new Map<string, { title: string; body: string }>()
  failNext = false

  key(space: string, id: string): string {
    return `${space}/${id}`
  }

  add(n: Partial<NoteView> & { space: string; createdBy: string }): NoteView {
    const id = n.id ?? newId()
    const created = n.created ?? iso(Date.now())
    const note: NoteView = {
      path: `notes/${id}.md`,
      blobOid: '',
      title: '',
      body: '',
      checklist: false,
      color: null,
      pinned: false,
      archived: false,
      trashed: null,
      labels: [],
      updated: created,
      order: null,
      source: null,
      ...n,
      id,
      created,
    }
    this.stamp(note)
    this.notes.set(this.key(note.space, id), note)
    return note
  }

  /** A new blob id for the note's current version. */
  stamp(note: NoteView): void {
    note.checklist = isChecklist(note.body)
    note.blobOid = newId().toLowerCase()
    this.versions.set(note.blobOid, { title: note.title, body: note.body })
  }
}

function seedNotes(fake: FakeNotes, user: FakeUser): void {
  const now = Date.now()
  fake.add({
    space: user.handle,
    createdBy: user.email,
    created: iso(now - 5 * 60_000),
    title: 'Groceries',
    body: '- [ ] Oat milk\n- [ ] Coffee beans\n- [x] Eggs',
    color: 'yellow',
    pinned: true,
    labels: ['Home'],
  })
  fake.add({
    space: user.handle,
    createdBy: user.email,
    created: iso(now - DAY),
    title: 'Board meeting ideas',
    body: 'Open with the pilot results.\nAsk about the second lab.',
    color: 'blue',
    labels: ['Work'],
  })
  fake.add({
    space: user.handle,
    createdBy: user.email,
    created: iso(now - 2 * DAY),
    body: 'Wifi password for the lab guest network is on the fridge.',
  })
  fake.add({
    space: 'team',
    createdBy: SAM.email,
    created: iso(now - 3 * DAY),
    title: 'Offsite packing list',
    body: '- [ ] Projector\n- [ ] Name badges',
    color: 'green',
  })
  fake.add({
    space: user.handle,
    createdBy: user.email,
    created: iso(now - 40 * DAY),
    title: 'Old parking spot',
    body: 'Level 2, row C.',
    archived: true,
  })
}

export interface NoteHandlerDeps {
  notes: FakeNotes
  latencyMs: number
  principal: (request: Request) => FakeUser | Response
  broadcast: (event: ServerEvent) => void
  seeded: boolean
}

const sortKey = (n: NoteView) => n.order ?? Date.parse(n.created)

export function noteHandlers(deps: NoteHandlerDeps): AnyHandler[] {
  const { notes: fake, principal } = deps
  const wait = () => (deps.latencyMs > 0 ? delay(deps.latencyMs) : Promise.resolve())
  const canAccess = (user: FakeUser, space: string) => space === 'team' || space === user.handle
  const changed = (space: string, id: string) =>
    deps.broadcast({ type: 'changed', space, headOid: newId(), paths: [`notes/${id}.md`] })

  const authed =
    (
      fn: (args: {
        request: Request
        user: FakeUser
        params: Record<string, unknown>
        url: URL
      }) => Response | Promise<Response>,
    ) =>
    async ({ request, params }: { request: Request; params: Record<string, unknown> }) => {
      await wait()
      const user = principal(request)
      if (user instanceof Response) return user
      if (deps.seeded && !fake.seeded.has(user.email)) {
        fake.seeded.add(user.email)
        seedNotes(fake, user)
      }
      return fn({ request, user, params, url: new URL(request.url) })
    }

  const failed = () => {
    if (!fake.failNext) return null
    fake.failNext = false
    return error(500, 'server_error', 'The server fell over')
  }

  const one = (user: FakeUser, params: Record<string, unknown>): NoteView | Response => {
    const space = String(params.space)
    if (!canAccess(user, space)) return error(403, 'forbidden', 'You cannot open this space')
    return (
      fake.notes.get(fake.key(space, String(params.id))) ?? error(404, 'not_found', 'No such note')
    )
  }

  const apply = (note: NoteView, p: NoteInput): Response | null => {
    if (p.color !== undefined && p.color !== null && !NOTE_COLORS.includes(p.color)) {
      return error(400, 'bad_request', 'Unknown color')
    }
    let content = false
    if (p.title !== undefined && noteTitle(p.title) !== note.title) {
      note.title = noteTitle(p.title)
      content = true
    }
    if (p.body !== undefined && noteTextOf(p.body) !== note.body) {
      note.body = noteTextOf(p.body)
      content = true
    }
    if (p.color !== undefined) note.color = p.color
    if (p.pinned !== undefined) note.pinned = p.pinned
    if (p.archived !== undefined) note.archived = p.archived
    if (p.labels !== undefined) note.labels = cleanLabels(p.labels)
    if (p.order !== undefined) note.order = p.order
    if (content) note.updated = iso(Date.now())
    return null
  }

  return [
    http.get(
      '/api/notes',
      authed(({ user, url }) => {
        const view = url.searchParams.get('view') ?? 'board'
        const label = url.searchParams.get('label')?.toLowerCase()
        const q = url.searchParams.get('q')?.toLowerCase()
        const cutoff = iso(Date.now() - 30 * DAY)
        const list = [...fake.notes.values()]
          .filter((n) => canAccess(user, n.space))
          .filter((n) => {
            if (view === 'trash') return !!n.trashed && n.trashed >= cutoff
            if (n.trashed) return false
            if (n.archived !== (view === 'archive')) return false
            if (label && !n.labels.some((l) => l.toLowerCase() === label)) return false
            return true
          })
          .filter((n) => !q || `${n.title}\n${n.body}`.toLowerCase().includes(q))
          .sort((a, b) =>
            view === 'trash'
              ? (b.trashed ?? '').localeCompare(a.trashed ?? '')
              : Number(b.pinned) - Number(a.pinned) || sortKey(b) - sortKey(a),
          )
        return HttpResponse.json({ notes: list.map((n) => ({ ...n })) })
      }),
    ),

    http.get(
      '/api/notes/labels',
      authed(({ user }) => {
        const counts = new Map<string, { name: string; count: number }>()
        for (const n of fake.notes.values()) {
          if (!canAccess(user, n.space) || n.trashed) continue
          for (const l of n.labels) {
            const e = counts.get(l.toLowerCase()) ?? { name: l, count: 0 }
            e.count++
            counts.set(l.toLowerCase(), e)
          }
        }
        return HttpResponse.json([...counts.values()].sort((a, b) => a.name.localeCompare(b.name)))
      }),
    ),

    http.post(
      '/api/notes',
      authed(async ({ request, user }) => {
        const refused = failed()
        if (refused) return refused
        const body = (await request.json()) as NoteInput & { space?: string }
        const space = body.space ?? user.handle
        if (!canAccess(user, space)) return error(403, 'forbidden', 'You cannot open this space')
        const note = fake.add({ space, createdBy: user.email })
        const bad = apply(note, body)
        if (bad) {
          fake.notes.delete(fake.key(space, note.id))
          return bad
        }
        note.updated = note.created
        fake.stamp(note)
        changed(space, note.id)
        return HttpResponse.json(note, { status: 201 })
      }),
    ),

    http.post(
      '/api/notes/import/keep',
      authed(async ({ request, user }) => {
        const body = (await request.json()) as { notes: Array<{ ref: string; note: KeepNote }> }
        const done = new Set(
          [...fake.notes.values()]
            .filter((n) => n.space === user.handle && n.source?.from === 'keep')
            .map((n) => n.source?.ref),
        )
        let imported = 0
        let skipped = 0
        for (const { ref, note } of body.notes) {
          const m = done.has(ref) ? null : mapKeepNote(note, ref)
          if (!m) {
            skipped++
            continue
          }
          done.add(ref)
          fake.add({
            space: user.handle,
            createdBy: user.email,
            title: m.title ?? '',
            body: noteTextOf(m.body ?? ''),
            color: m.color ?? null,
            pinned: !!m.pinned,
            archived: !!m.archived,
            labels: m.labels ?? [],
            ...(m.created ? { created: m.created, updated: m.updated ?? m.created } : {}),
            source: m.source ?? null,
          })
          imported++
        }
        if (imported > 0) changed(user.handle, 'import')
        return HttpResponse.json({ imported, skipped })
      }),
    ),

    http.get(
      '/api/notes/:space/:id',
      authed(({ user, params }) => {
        const note = one(user, params)
        return note instanceof Response ? note : HttpResponse.json(note)
      }),
    ),

    http.patch(
      '/api/notes/:space/:id',
      authed(async ({ request, user, params }) => {
        const note = one(user, params)
        if (note instanceof Response) return note
        const refused = failed()
        if (refused) return refused
        const body = (await request.json()) as NoteInput & { baseBlobOid?: string }
        if (
          body.baseBlobOid &&
          body.baseBlobOid !== note.blobOid &&
          (body.title !== undefined || body.body !== undefined)
        ) {
          const base = fake.versions.get(body.baseBlobOid)
          const titleChanged = body.title !== undefined && base?.title !== note.title
          const bodyChanged = body.body !== undefined && base?.body !== note.body
          if (!base || titleChanged || bodyChanged) {
            return error(409, 'conflict', 'Someone else changed this note; reload to see theirs')
          }
        }
        const bad = apply(note, body)
        if (bad) return bad
        fake.stamp(note)
        changed(note.space, note.id)
        return HttpResponse.json(note)
      }),
    ),

    http.post(
      '/api/notes/:space/:id/trash',
      authed(({ user, params }) => {
        const note = one(user, params)
        if (note instanceof Response) return note
        if (!note.trashed) {
          note.trashed = iso(Date.now())
          note.pinned = false
          fake.stamp(note)
          changed(note.space, note.id)
        }
        return HttpResponse.json(note)
      }),
    ),

    http.post(
      '/api/notes/:space/:id/restore',
      authed(({ user, params }) => {
        const note = one(user, params)
        if (note instanceof Response) return note
        if (note.trashed) {
          note.trashed = null
          fake.stamp(note)
          changed(note.space, note.id)
        }
        return HttpResponse.json(note)
      }),
    ),

    http.post(
      '/api/notes/:space/:id/move',
      authed(async ({ request, user, params }) => {
        const note = one(user, params)
        if (note instanceof Response) return note
        const { toSpace } = (await request.json()) as { toSpace: string }
        if (!canAccess(user, toSpace)) return error(403, 'forbidden', 'You cannot open this space')
        fake.notes.delete(fake.key(note.space, note.id))
        const from = note.space
        note.space = toSpace
        fake.stamp(note)
        fake.notes.set(fake.key(toSpace, note.id), note)
        changed(from, note.id)
        changed(toSpace, note.id)
        return HttpResponse.json(note)
      }),
    ),

    http.delete(
      '/api/notes/:space/:id',
      authed(({ user, params }) => {
        const note = one(user, params)
        if (note instanceof Response) return note
        fake.notes.delete(fake.key(note.space, note.id))
        changed(note.space, note.id)
        return new HttpResponse(null, { status: 204 })
      }),
    ),
  ]
}
