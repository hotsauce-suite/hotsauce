import { type AnyHandler, delay, HttpResponse, http, ws } from 'msw'
import type { Author, CommitResult, Me, ServerEvent } from '../api/types'
import { assistantHandlers } from './assistantHandlers'
import { boardHandlers, FakeBoards, seedBoards } from './boardHandlers'
import { bookingHandlers } from './bookingHandlers'
import { briefcastHandlers, FakeBriefcasts } from './briefcastHandlers'
import { briefHandlers, FakeBriefs } from './briefHandlers'
import { checkinHandlers } from './checkinHandlers'
import { dictationHandlers } from './dictationHandlers'
import { FakeMeetings } from './fakeMeetings'
import { FakeRepo, type FakeUser } from './fakeRepo'
import { FakeFiles, fileHandlers, seedFiles } from './fileHandlers'
import { FakeForms, formHandlers, seedForms } from './formHandlers'
import { meetingHandlers } from './meetingHandlers'
import { FakeNotes, noteHandlers } from './noteHandlers'
import { peopleHandlers } from './peopleHandlers'
import { seed, seedPersonal } from './seed'
import { FakeTasks, taskHandlers } from './taskHandlers'
import { todayHandlers } from './todayHandlers'

const ALLOWED_DOMAIN = 'example.test'
const MAX_ASSET_BYTES = 10 * 1024 * 1024

function userFromEmail(email: string): FakeUser {
  const local = email.split('@')[0] ?? email
  const name = local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ')
  return { email, name: name || local, handle: local.toLowerCase().replace(/[^a-z0-9-]/g, '-') }
}

interface MockToken {
  id: string
  name: string
  hint: string
  createdAt: string
  lastUsedAt: string | null
  email: string
}
const publicToken = ({ email: _email, ...t }: MockToken) => t

const error = (status: number, code: string, message: string) =>
  HttpResponse.json({ error: { code, message } }, { status })

export interface MockApi {
  repo: FakeRepo
  meetings: FakeMeetings
  tasks: FakeTasks
  notes: FakeNotes
  boards: FakeBoards
  files: FakeFiles
  forms: FakeForms
  handlers: AnyHandler[]
  /** Pushes a server event to every authenticated socket, like the real broadcaster. */
  broadcast: (event: ServerEvent) => void
  /** Drops a meeting's audio sockets, as a network failure would. */
  dropMeetingSockets: (sessionId: string) => void
}

// One link per page: every ws.link() adds a listener to MSW's shared BroadcastChannel.
const socket = ws.link(new URL('/ws', window.location.origin).href.replace(/^http/, 'ws'))

function createHandlers(
  repo: FakeRepo,
  meetings: FakeMeetings,
  tasks: FakeTasks,
  notes: FakeNotes,
  work: { boards: FakeBoards; files: FakeFiles; forms: FakeForms },
  latencyMs: number,
  seeded: boolean,
): Omit<MockApi, 'repo' | 'meetings' | 'tasks' | 'notes' | 'boards' | 'files' | 'forms'> {
  const ready = new Set<{ send: (data: string) => void }>()

  const broadcast = (event: ServerEvent) => {
    for (const client of ready) client.send(JSON.stringify(event))
  }

  const wait = () => (latencyMs > 0 ? delay(latencyMs) : Promise.resolve())

  /** Authenticates like the dev server: header email, domain lock, personal space provisioning. */
  function principal(request: Request): FakeUser | Response {
    const email = request.headers.get('x-hearth-dev-user')?.trim().toLowerCase()
    const bearer = request.headers.get('authorization')
    if (!email && !bearer) return error(401, 'unauthorized', 'Sign in to continue')
    const user = userFromEmail(email ?? `ada@${ALLOWED_DOMAIN}`)
    if (!user.email.endsWith(`@${ALLOWED_DOMAIN}`)) {
      return error(403, 'domain_not_allowed', `Only ${ALLOWED_DOMAIN} accounts are allowed`)
    }
    seedPersonal(repo, user)
    return user
  }

  const authorOf = (user: FakeUser): Author => ({ name: user.name, email: user.email })

  const canAccess = (user: FakeUser, space: string) => space === 'team' || space === user.handle

  type Resolver = (args: {
    request: Request
    user: FakeUser
    space: string
    url: URL
  }) => Response | Promise<Response>

  /** Wraps a /api/spaces/:space route with latency, auth and the space check. */
  const spaceRoute =
    (resolve: Resolver) =>
    async ({ request, params }: { request: Request; params: Record<string, unknown> }) => {
      await wait()
      const user = principal(request)
      if (user instanceof Response) return user
      const space = String(params.space)
      if (!canAccess(user, space)) return error(403, 'forbidden', 'You cannot open this space')
      return resolve({ request, user, space, url: new URL(request.url) })
    }

  const commitResponse = (result: CommitResult) =>
    HttpResponse.json(result, { status: result.status === 'conflict' ? 409 : 200 })

  const afterCommit = (space: string, paths: string[]) =>
    broadcast({ type: 'changed', space, headOid: repo.space(space).headOid(), paths })

  const socketHandler = socket.addEventListener('connection', ({ client }) => {
    const timer = setTimeout(() => {
      if (!ready.has(client)) client.close(4401, 'auth timeout')
    }, 5000)
    client.addEventListener('message', (event) => {
      if (ready.has(client)) return
      let message: { type?: string; devUser?: unknown; token?: unknown } = {}
      try {
        message = JSON.parse(String(event.data))
      } catch {
        // Falls through to the failure below.
      }
      const email = typeof message.devUser === 'string' ? message.devUser : null
      const authed =
        message.type === 'auth' &&
        (typeof message.token === 'string' || email?.endsWith(`@${ALLOWED_DOMAIN}`) === true)
      clearTimeout(timer)
      if (!authed) {
        client.close(4401, 'unauthorized')
        return
      }
      ready.add(client)
      client.send(JSON.stringify({ type: 'ready' }))
    })
    client.addEventListener('close', () => {
      clearTimeout(timer)
      ready.delete(client)
    })
  })

  // Access tokens live as long as this mock API (one test, or one page load).
  const mockTokens: MockToken[] = []

  const handlers: AnyHandler[] = [
    socketHandler,

    // VITE_MOCK_AUTH_MODE=clerk shows the Clerk sign-in against the mock (API calls stay dev-authed).
    http.get('/api/health', () =>
      HttpResponse.json({
        ok: true,
        authMode: import.meta.env.VITE_MOCK_AUTH_MODE === 'clerk' ? 'clerk' : 'dev',
        setupRequired: false,
        productName: 'Hotsauce',
        orgName: 'Acme',
        clerkPublishableKey: null,
        chatUrl: 'https://chat.example.test',
        signInDomain: 'example.test',
        features: { ai: true, transcription: true },
        version: '0.8.0',
      }),
    ),

    // The default brand: no overrides, so the app keeps its own look.
    http.get('/api/org/brand', () =>
      HttpResponse.json({
        productName: 'Hotsauce',
        orgName: 'Acme',
        primary: '#c63d19',
        accent: '#ee9a46',
        neutral: 'warm',
        fonts: {
          choice: 'classic',
          label: 'Fraunces + IBM Plex Sans',
          display: 'Fraunces',
          ui: 'IBM Plex Sans',
        },
        defaultTheme: 'system',
        logoUrl: null,
        markUrl: null,
        voice: '',
        updatedAt: null,
      }),
    ),

    http.get('/api/me', async ({ request }) => {
      await wait()
      const user = principal(request)
      if (user instanceof Response) return user
      const me: Me = {
        principal: {
          userId: `user_${user.handle}`,
          email: user.email,
          name: user.name,
          handle: user.handle,
          isAdmin: false,
        },
        spaces: [
          { name: 'team', kind: 'team', label: 'Team' },
          { name: user.handle, kind: 'personal', label: 'Personal' },
        ],
        settings: { idleCommitMs: repo.idleCommitMs },
      }
      return HttpResponse.json(me)
    }),

    // Access tokens (ARCHITECTURE §8.1), kept in memory per page.
    http.get('/api/tokens', ({ request }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      return HttpResponse.json(mockTokens.filter((t) => t.email === user.email).map(publicToken))
    }),
    http.post('/api/tokens', async ({ request }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      const { name } = (await request.json()) as { name?: string }
      if (!name?.trim()) return error(400, 'bad_request', 'A token name is 1 to 80 characters')
      const token = `hth_mock${crypto.randomUUID().replaceAll('-', '')}`
      const entry = {
        id: crypto.randomUUID(),
        name: name.trim(),
        hint: token.slice(-4),
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        email: user.email,
      }
      mockTokens.push(entry)
      return HttpResponse.json({ ...publicToken(entry), token }, { status: 201 })
    }),
    http.delete('/api/tokens/:id', ({ request, params }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      const i = mockTokens.findIndex((t) => t.id === params.id && t.email === user.email)
      if (i === -1) return error(404, 'not_found', 'No such token')
      mockTokens.splice(i, 1)
      return new HttpResponse(null, { status: 204 })
    }),

    http.get(
      '/api/spaces/:space/tree',
      spaceRoute(({ space, url }) =>
        HttpResponse.json(repo.space(space).list(url.searchParams.get('dir') ?? '')),
      ),
    ),

    http.get(
      '/api/spaces/:space/file',
      spaceRoute(({ space, url }) => {
        const path = url.searchParams.get('path') ?? ''
        const file = repo.read(space, path, url.searchParams.get('ref') ?? undefined)
        return file ? HttpResponse.json(file) : error(404, 'not_found', `No file at ${path}`)
      }),
    ),

    http.put(
      '/api/spaces/:space/file',
      spaceRoute(async ({ request, space, user }) => {
        const body = (await request.json()) as {
          path: string
          content: string
          baseBlobOid?: string
          label?: string
          message?: string
          createOnly?: boolean
        }
        if (body.createOnly && repo.read(space, body.path)) {
          return error(409, 'conflict', `${body.path} already exists`)
        }
        const result = repo.put(space, body, authorOf(user))
        if (result.status === 'conflict') {
          broadcast({ type: 'conflict', space, path: body.path, ref: result.conflictRef })
        } else afterCommit(space, [body.path])
        return commitResponse(result)
      }),
    ),

    http.delete(
      '/api/spaces/:space/file',
      spaceRoute(async ({ request, space, user }) => {
        const { path } = (await request.json()) as { path: string }
        const result = repo.remove(space, path, authorOf(user))
        if (!result) return error(404, 'not_found', `No file at ${path}`)
        afterCommit(space, [path])
        return HttpResponse.json(result)
      }),
    ),

    http.post(
      '/api/spaces/:space/move',
      spaceRoute(async ({ request, space, user }) => {
        const { from, to } = (await request.json()) as { from: string; to: string }
        const result = repo.move(space, from, to, authorOf(user))
        if (!result) return error(400, 'bad_request', `Cannot move ${from} to ${to}`)
        afterCommit(space, [from, to])
        return HttpResponse.json(result)
      }),
    ),

    http.post(
      '/api/spaces/:space/share-to-team',
      spaceRoute(async ({ request, space, user }) => {
        const { path, toFolder } = (await request.json()) as { path: string; toFolder: string }
        if (space === 'team') return error(400, 'bad_request', 'Already in the team space')
        const result = repo.shareToTeam(space, path, toFolder, authorOf(user))
        if (!result) return error(404, 'not_found', `No file at ${path}`)
        afterCommit(space, [path])
        afterCommit('team', [result.teamPath])
        return HttpResponse.json(result)
      }),
    ),

    http.post(
      '/api/spaces/:space/folder',
      spaceRoute(async ({ request, space, user }) => {
        const { path } = (await request.json()) as { path: string }
        const result = repo.createFolder(space, path, authorOf(user))
        afterCommit(space, [`${path}/.gitkeep`])
        return HttpResponse.json(result)
      }),
    ),

    http.get(
      '/api/spaces/:space/history',
      spaceRoute(({ space, url }) => {
        const limit = Number(url.searchParams.get('limit') ?? 50)
        return HttpResponse.json(repo.history(space, url.searchParams.get('path') ?? '', limit))
      }),
    ),

    http.get(
      '/api/spaces/:space/show',
      spaceRoute(({ space, url }) => {
        const content = repo
          .space(space)
          .contentAt(url.searchParams.get('oid') ?? '', url.searchParams.get('path') ?? '')
        return content === null
          ? error(404, 'not_found', 'No such version')
          : HttpResponse.json({ content })
      }),
    ),

    http.get(
      '/api/spaces/:space/diff',
      spaceRoute(({ space, url }) => {
        const q = (key: string) => url.searchParams.get(key) ?? ''
        return HttpResponse.json({ diff: repo.diff(space, q('from'), q('to'), q('path')) })
      }),
    ),

    http.post(
      '/api/spaces/:space/restore',
      spaceRoute(async ({ request, space, user }) => {
        const { oid, path } = (await request.json()) as { oid: string; path: string }
        const result = repo.restore(space, oid, path, authorOf(user))
        if (!result) return error(404, 'not_found', 'No such version')
        afterCommit(space, [path])
        return commitResponse(result)
      }),
    ),

    http.get(
      '/api/spaces/:space/conflicts',
      spaceRoute(({ space }) => HttpResponse.json(repo.listConflicts(space))),
    ),

    http.get(
      '/api/spaces/:space/conflict',
      spaceRoute(({ space, url }) => {
        const detail = repo.conflict(space, url.searchParams.get('ref') ?? '')
        return detail ? HttpResponse.json(detail) : error(404, 'not_found', 'No such conflict')
      }),
    ),

    http.post(
      '/api/spaces/:space/conflict/resolve',
      spaceRoute(async ({ request, space, user }) => {
        const { ref, content } = (await request.json()) as { ref: string; content: string }
        const path = repo.conflict(space, ref)?.path
        const result = repo.resolve(space, ref, content, authorOf(user))
        if (!result || !path) return error(404, 'not_found', 'No such conflict')
        afterCommit(space, [path])
        return commitResponse(result)
      }),
    ),

    http.post(
      '/api/spaces/:space/assets',
      spaceRoute(async ({ request, space }) => {
        const form = await request.formData()
        const file = form.get('file')
        if (!(file instanceof File)) return error(400, 'bad_request', 'Expected a file field')
        if (file.size > MAX_ASSET_BYTES) {
          return error(413, 'too_large', 'Images must be 10 MB or smaller')
        }
        const bytes = await file.arrayBuffer()
        const path = repo.uploadAsset(
          space,
          file.name,
          bytes,
          file.type || 'application/octet-stream',
        )
        afterCommit(space, [path])
        return HttpResponse.json({ path })
      }),
    ),

    http.get(
      '/api/spaces/:space/raw',
      spaceRoute(({ space, url }) => {
        const path = url.searchParams.get('path') ?? ''
        const asset = repo.space(space).binaries.get(path)
        if (asset) return new HttpResponse(asset.bytes, { headers: { 'content-type': asset.type } })
        const text = repo.space(space).files.get(path)
        return text === undefined
          ? error(404, 'not_found', `No file at ${path}`)
          : new HttpResponse(text, { headers: { 'content-type': 'text/plain' } })
      }),
    ),

    http.get('/api/search', async ({ request }) => {
      await wait()
      const user = principal(request)
      if (user instanceof Response) return user
      const url = new URL(request.url)
      const spaces = (url.searchParams.get('spaces') ?? '')
        .split(',')
        .filter((s) => s && canAccess(user, s))
      return HttpResponse.json(repo.search(url.searchParams.get('q') ?? '', spaces))
    }),

    http.get('/api/recents', ({ request }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      return HttpResponse.json(repo.recents.get(user.email) ?? [])
    }),

    http.post('/api/recents', async ({ request }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      const { space, path } = (await request.json()) as { space: string; path: string }
      repo.addRecent(user.email, space, path)
      return HttpResponse.json({ ok: true })
    }),

    http.get('/api/stars', ({ request }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      return HttpResponse.json(repo.stars.get(user.email) ?? [])
    }),

    http.post('/api/stars', async ({ request }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      const body = (await request.json()) as { space: string; path: string; starred: boolean }
      repo.setStar(user.email, body.space, body.path, body.starred)
      return HttpResponse.json({ ok: true })
    }),

    http.get('/api/pins', ({ request }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      return HttpResponse.json({ pins: repo.pins.get(user.email) ?? null })
    }),

    http.put('/api/pins', async ({ request }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      const { pins } = (await request.json()) as { pins: string[] }
      repo.pins.set(user.email, pins)
      return HttpResponse.json({ pins })
    }),
  ]

  // Before the meetings routes: ticking a meeting's action item is recorded here first.
  handlers.push(...taskHandlers({ tasks, latencyMs, principal, broadcast, seeded }))
  handlers.push(...noteHandlers({ notes, latencyMs, principal, broadcast, seeded }))

  const meetingRoutes = meetingHandlers({
    repo,
    meetings,
    latencyMs,
    principal,
    afterCommit,
    userFromEmail,
  })
  handlers.push(...meetingRoutes.handlers)
  handlers.push(...dictationHandlers({ principal }))
  handlers.push(...boardHandlers({ boards: work.boards, latencyMs, principal, seeded }))
  handlers.push(...fileHandlers({ files: work.files, latencyMs, principal }))
  handlers.push(...formHandlers({ forms: work.forms, files: work.files, latencyMs, principal }))
  handlers.push(...todayHandlers())
  handlers.push(...checkinHandlers({ principal }))
  handlers.push(...assistantHandlers({ repo, principal, latencyMs }))
  handlers.push(...peopleHandlers())
  handlers.push(...bookingHandlers())
  handlers.push(
    ...briefHandlers({
      briefs: new FakeBriefs(),
      latencyMs,
      principal,
      meetingCount: (user) => meetings.list(['team', user.handle], {}).length,
    }),
  )
  handlers.push(
    ...briefcastHandlers({
      briefcasts: new FakeBriefcasts(),
      latencyMs,
      principal,
      meetingCount: (user) => meetings.list(['team', user.handle], {}).length,
    }),
  )

  return { handlers, broadcast, dropMeetingSockets: meetingRoutes.dropSockets }
}

export function createMockApi(opts: { latencyMs?: number; seeded?: boolean } = {}): MockApi {
  const repo = new FakeRepo()
  if (opts.seeded ?? true) seed(repo)
  const meetings = new FakeMeetings(repo)
  const tasks = new FakeTasks(repo)
  const notes = new FakeNotes()
  const seeded = opts.seeded ?? true
  const work = { boards: new FakeBoards(), files: new FakeFiles(), forms: new FakeForms() }
  if (seeded) {
    seedBoards(work.boards)
    seedFiles(work.files)
    seedForms(work.forms)
  }
  return {
    repo,
    meetings,
    tasks,
    notes,
    ...work,
    ...createHandlers(repo, meetings, tasks, notes, work, opts.latencyMs ?? 0, seeded),
  }
}
