// MSW routes for `/api/comments` (ARCHITECTURE §27.3): conversations under team docs, meeting
// notes and tasks, kept in memory, with a few sample comments so the demo shows a lived-in one.

import {
  COMMENTS_FOLDER,
  emptyForYouState,
  extractTitle,
  type ForYouState,
  forYouStanding,
  laterUntil,
  MAX_COMMENT,
  MAX_COMMENT_QUOTE,
  markForYou,
  mentionedEmails,
} from '@hotsauce/format'
import { type AnyHandler, delay, HttpResponse, http } from 'msw'
import type { Comment, CommentMember } from '../api/comments'
import type { ForYouItem, ForYouView } from '../api/forYou'
import type { ServerEvent } from '../api/types'
import type { FakeRepo, FakeUser } from './fakeRepo'
import { ADA, PRIYA, SAM } from './seed'

const error = (status: number, code: string, message: string) =>
  HttpResponse.json({ error: { code, message } }, { status })

const handleOf = (email: string) => (email.split('@')[0] ?? email).toLowerCase()
const BASE: CommentMember[] = [ADA, PRIYA, SAM].map((a) => ({
  email: a.email,
  name: a.name,
  handle: handleOf(a.email),
}))

type Stored = Omit<Comment, 'mine' | 'canEdit' | 'canDelete' | 'mentions'> & { mentions: string[] }

interface Sample {
  author: CommentMember
  text: string
  hoursAgo: number
  quote?: string
}

/** Sample conversations, by the doc's path or the task's title. */
const DOC_SAMPLES: Record<string, Sample[]> = {
  'docs/plans/q4-plan.md': [
    {
      author: BASE[1] as CommentMember,
      text: 'Two of the three pilots have verbally agreed. I’d keep the third as a stretch, not a commitment.',
      hoursAgo: 50,
    },
    {
      author: BASE[2] as CommentMember,
      text: '@Ada Lovelace can we move this to Dec 1? The supplier quote lands the week of Nov 24.',
      hoursAgo: 26,
      quote: 'revisit on Nov 15',
    },
  ],
}
const TASK_SAMPLES: Record<string, Sample[]> = {
  'Ship the pilot report': [
    {
      author: BASE[1] as CommentMember,
      text: 'Charts are in the shared folder. @Ada Lovelace the stability numbers still need your eyes.',
      hoursAgo: 20,
    },
  ],
}

export interface CommentHandlerDeps {
  repo: FakeRepo
  latencyMs: number
  seeded: boolean
  principal: (request: Request) => FakeUser | Response
  broadcast: (event: ServerEvent) => void
  /** The title of the team task at `path`, or null when there is none. */
  taskTitle: (path: string) => string | null
  /** Every team task's path, so For you can find the sample conversations before they're opened. */
  teamTaskPaths?: (user: FakeUser) => string[]
}

export function commentHandlers(deps: CommentHandlerDeps): AnyHandler[] {
  const wait = () => (deps.latencyMs > 0 ? delay(deps.latencyMs) : Promise.resolve())
  let seq = 0
  const nextId = () => `01JCMT${String(++seq).padStart(20, '0')}`
  /** Item ids by path, and each item's comments, oldest first. */
  const items = new Map<string, string>()
  const threads = new Map<string, Stored[]>()

  const members = (user: FakeUser): CommentMember[] =>
    BASE.some((m) => m.email === user.email)
      ? BASE
      : [...BASE, { email: user.email, name: user.name, handle: user.handle }]

  const isTask = (path: string) => /^tasks\/[^/]+\.md$/.test(path)
  const exists = (path: string) =>
    isTask(path) ? deps.taskTitle(path) !== null : deps.repo.space('team').files.has(path)

  const make = (item: string, sample: Sample): Stored => ({
    id: nextId(),
    item,
    author: sample.author.email,
    name: sample.author.name,
    created: new Date(Date.now() - sample.hoursAgo * 3_600_000).toISOString(),
    edited: null,
    text: sample.text,
    quote: sample.quote ?? null,
    mentions: mentionedEmails(sample.text, BASE),
    via: null,
  })

  const threadOf = (path: string): { item: string; list: Stored[] } => {
    let item = items.get(path)
    if (!item) {
      item = `01JITEM${String(items.size + 1).padStart(19, '0')}`
      items.set(path, item)
      const samples = deps.seeded
        ? isTask(path)
          ? TASK_SAMPLES[deps.taskTitle(path) ?? '']
          : DOC_SAMPLES[path]
        : undefined
      const id = item
      threads.set(
        item,
        (samples ?? []).map((s) => make(id, s)),
      )
    }
    return { item, list: threads.get(item) ?? [] }
  }

  const view = (c: Stored, user: FakeUser): Comment => {
    const all = members(user)
    const mine = c.author === user.email
    return {
      ...c,
      mentions: c.mentions.map((email) => ({
        email,
        name: all.find((m) => m.email === email)?.name ?? email,
      })),
      mine,
      canEdit: mine,
      canDelete: mine,
    }
  }

  const changed = (c: Stored) =>
    deps.broadcast({
      type: 'changed',
      space: 'team',
      headOid: `comments-${seq}-${Date.now()}`,
      paths: [`${COMMENTS_FOLDER}/${c.item}/${c.id}.md`],
    })

  // For you (ARCHITECTURE §27.5), worked out from these conversations; marks per member in memory.
  const marks = new Map<string, ForYouState>()
  const pathOf = (item: string) => [...items].find(([, id]) => id === item)?.[0] ?? null
  const titleOf = (path: string) =>
    isTask(path)
      ? (deps.taskTitle(path) ?? 'A task')
      : extractTitle(deps.repo.space('team').files.get(path) ?? '') ||
        (path.split('/').pop() ?? path).replace(/\.md$/, '')
  const forYou = (user: FakeUser): ForYouView => {
    // The samples exist from the start, as they would on a server.
    if (deps.seeded) {
      for (const path of Object.keys(DOC_SAMPLES)) if (exists(path)) threadOf(path)
      for (const path of deps.teamTaskPaths?.(user) ?? []) threadOf(path)
    }
    const state = marks.get(user.email) ?? emptyForYouState()
    const now = new Date()
    const out: ForYouItem[] = []
    for (const [item, list] of threads) {
      const path = pathOf(item)
      if (!path || !exists(path)) continue
      const named = list.filter((c) => c.mentions.includes(user.email) && c.author !== user.email)
      const latest = named.at(-1)
      if (!latest) continue
      const standing = forYouStanding(state.items[item], latest.created, now)
      if (!standing.shown) continue
      out.push({
        item,
        space: 'team',
        path,
        title: titleOf(path),
        kind: isTask(path) ? 'task' : path.startsWith('meetings/') ? 'meeting' : 'docs',
        url: `${
          isTask(path)
            ? `/tasks/item/team/${path.slice('tasks/'.length, -'.md'.length)}`
            : `/${path.startsWith('meetings/') ? 'meetings' : 'docs'}/team/${path}`
        }#comment-${latest.id}`,
        comment: {
          id: latest.id,
          author: latest.author,
          name: latest.name,
          text: latest.text.replace(/\s+/g, ' ').slice(0, 200),
          created: latest.created,
        },
        mentions: named.length,
        at: standing.at,
        unseen: standing.unseen,
      })
    }
    out.sort((a, b) => b.at.localeCompare(a.at))
    return { items: out, unseen: out.filter((i) => i.unseen).length, canMark: true }
  }

  const find = (item: string, id: string) => threads.get(item)?.find((c) => c.id === id)

  const authed =
    (
      fn: (ctx: {
        request: Request
        user: FakeUser
        params: Record<string, unknown>
        url: URL
      }) => Response | Promise<Response>,
    ) =>
    async ({ request, params }: { request: Request; params: Record<string, unknown> }) => {
      await wait()
      const user = deps.principal(request)
      if (user instanceof Response) return user
      return fn({ request, user, params, url: new URL(request.url) })
    }

  return [
    http.get(
      '/api/for-you',
      authed(({ user }) => HttpResponse.json(forYou(user))),
    ),
    http.post(
      '/api/for-you/:item',
      authed(async ({ request, user, params }) => {
        const body = (await request.json()) as {
          action?: string
          when?: 'tomorrow' | 'monday'
          zone?: string
        }
        const item = String(params.item)
        const now = new Date()
        const before = marks.get(user.email) ?? emptyForYouState()
        let next: ForYouState
        if (body.action === 'later') {
          let until: Date
          try {
            until = laterUntil(
              body.when === 'monday' ? 'monday' : 'tomorrow',
              now,
              body.zone ?? 'UTC',
            )
          } catch {
            return error(400, 'bad_request', `Unknown time zone: ${body.zone}`)
          }
          next = markForYou(before, item, { action: 'later', until: until.toISOString() }, now)
        } else if (body.action === 'seen' || body.action === 'done' || body.action === 'undone') {
          next = markForYou(before, item, { action: body.action }, now)
        } else {
          return error(400, 'bad_request', 'Unknown action')
        }
        marks.set(user.email, next)
        return HttpResponse.json(forYou(user))
      }),
    ),
    http.get(
      '/api/comments/members',
      authed(({ user }) => HttpResponse.json({ members: members(user) })),
    ),
    http.get(
      '/api/comments',
      authed(({ user, url }) => {
        const space = url.searchParams.get('space') ?? ''
        const path = url.searchParams.get('path') ?? ''
        if (space !== 'team' || !path.endsWith('.md') || !exists(path)) {
          return HttpResponse.json({ canComment: false, comments: [] })
        }
        const { list } = threadOf(path)
        return HttpResponse.json({ canComment: true, comments: list.map((c) => view(c, user)) })
      }),
    ),
    http.post(
      '/api/comments',
      authed(async ({ request, user }) => {
        const body = (await request.json()) as {
          space?: string
          path?: string
          text?: string
          quote?: string
        }
        const text = (body.text ?? '').trim()
        if (body.space !== 'team') {
          return error(403, 'forbidden', 'Comments are for the team space')
        }
        if (!body.path || !exists(body.path)) {
          return error(404, 'not_found', 'Save this before commenting on it')
        }
        if (!text || text.length > MAX_COMMENT) {
          return error(400, 'bad_request', 'Write a comment first')
        }
        const { item, list } = threadOf(body.path)
        const all = members(user)
        const comment: Stored = {
          id: nextId(),
          item,
          author: user.email,
          name: all.find((m) => m.email === user.email)?.name ?? user.name,
          created: new Date().toISOString(),
          edited: null,
          text,
          quote: body.quote?.trim().slice(0, MAX_COMMENT_QUOTE) || null,
          mentions: mentionedEmails(text, all),
          via: null,
        }
        list.push(comment)
        changed(comment)
        return HttpResponse.json(view(comment, user), { status: 201 })
      }),
    ),
    http.patch(
      '/api/comments/:item/:id',
      authed(async ({ request, user, params }) => {
        const comment = find(String(params.item), String(params.id))
        if (!comment) return error(404, 'not_found', 'That comment is gone')
        if (comment.author !== user.email) {
          return error(403, 'forbidden', 'Only its author can edit a comment')
        }
        const text = ((await request.json()) as { text?: string }).text?.trim() ?? ''
        if (!text) return error(400, 'bad_request', 'Write a comment first')
        comment.text = text
        comment.edited = new Date().toISOString()
        comment.mentions = mentionedEmails(text, members(user))
        changed(comment)
        return HttpResponse.json(view(comment, user))
      }),
    ),
    http.delete(
      '/api/comments/:item/:id',
      authed(({ user, params }) => {
        const list = threads.get(String(params.item))
        const comment = list?.find((c) => c.id === String(params.id))
        if (!list || !comment) return error(404, 'not_found', 'That comment is gone')
        if (comment.author !== user.email) {
          return error(403, 'forbidden', 'Only its author can delete a comment')
        }
        list.splice(list.indexOf(comment), 1)
        changed(comment)
        return new HttpResponse(null, { status: 204 })
      }),
    ),
  ]
}
