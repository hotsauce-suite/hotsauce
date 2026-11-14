// MSW routes for `/api/meetings`, `/api/calendar` and the `/ws/meetings/:id` audio socket
// (ARCHITECTURE §7.2, §7.3), over FakeMeetings.

import {
  cleanSpeakerName,
  parseFrontmatter,
  parseTranscript,
  patchFrontmatter,
  renameSpeakers,
  transcriptPathFor,
} from '@hearth/format'
import { type AnyHandler, delay, HttpResponse, http, ws } from 'msw'
import type {
  ChatScope,
  CreateSessionBody,
  EnhanceBody,
  MeetingFilters,
  MeetingServerMessage,
  MeetingState,
} from '../api/types'
import { decodeAudioFrame } from '../apps/meetings/audio/socket'
import type { FakeMeetings, FakeSession } from './fakeMeetings'
import type { FakeRepo, FakeUser } from './fakeRepo'

const ALLOWED_DOMAIN = 'example.test'

// One link per page: every ws.link() adds a listener to MSW's shared BroadcastChannel.
const meetingSocket = ws.link(
  new URL('/ws/meetings/:id', window.location.origin).href.replace(/^http/, 'ws'),
)

const error = (status: number, code: string, message: string) =>
  HttpResponse.json({ error: { code, message } }, { status })

interface SocketClient {
  send: (data: string) => void
  close: (code?: number, reason?: string) => void
}

export interface MeetingHandlerDeps {
  repo: FakeRepo
  meetings: FakeMeetings
  latencyMs: number
  principal: (request: Request) => FakeUser | Response
  afterCommit: (space: string, paths: string[]) => void
  userFromEmail: (email: string) => FakeUser
}

export function meetingHandlers(deps: MeetingHandlerDeps): {
  handlers: AnyHandler[]
  /** Drops every socket of a session, as a network failure would. */
  dropSockets: (sessionId: string) => void
} {
  const { meetings, principal } = deps
  const wait = () => (deps.latencyMs > 0 ? delay(deps.latencyMs) : Promise.resolve())
  const clients = new Map<string, Set<SocketClient>>()
  const visible = (user: FakeUser) => ['team', user.handle]

  const push = (sessionId: string, message: MeetingServerMessage) => {
    for (const client of clients.get(sessionId) ?? []) client.send(JSON.stringify(message))
  }

  const setState = (session: FakeSession, state: MeetingState) => {
    session.state = state
    push(session.id, { type: 'state', state })
  }

  /** Auth plus "is this your session" for the session routes. */
  async function owned(
    request: Request,
    id: unknown,
  ): Promise<{ user: FakeUser; session: FakeSession } | Response> {
    await wait()
    const user = principal(request)
    if (user instanceof Response) return user
    const session = meetings.sessions.get(String(id))
    if (!session) return error(404, 'not_found', 'No such meeting session')
    if (session.owner !== user.email) return error(403, 'forbidden', 'Not your meeting')
    return { user, session }
  }

  const socketHandler = meetingSocket.addEventListener('connection', ({ client, params }) => {
    const id = String(params.id)
    let session: FakeSession | null = null
    const timer = setTimeout(() => {
      if (!session) client.close(4401, 'auth timeout')
    }, 5000)

    const onAudio = (bytes: Uint8Array) => {
      const frame = decodeAudioFrame(bytes)
      if (!session || !frame) return
      for (const segment of meetings.receive(id, frame.track, frame.pcm)) {
        client.send(JSON.stringify({ type: 'segment', segment } satisfies MeetingServerMessage))
      }
    }

    client.addEventListener('message', (event) => {
      const data: unknown = event.data
      if (!session) {
        clearTimeout(timer)
        let message: { type?: string; devUser?: unknown; token?: unknown } = {}
        try {
          message = typeof data === 'string' ? JSON.parse(data) : {}
        } catch {
          // Falls through to the refusal below.
        }
        const email =
          typeof message.devUser === 'string'
            ? message.devUser.toLowerCase()
            : typeof message.token === 'string'
              ? `ada@${ALLOWED_DOMAIN}`
              : null
        if (message.type !== 'auth' || !email?.endsWith(`@${ALLOWED_DOMAIN}`)) {
          client.close(4401, 'unauthorized')
          return
        }
        const found = meetings.sessions.get(id)
        if (!found || found.state === 'saved' || found.state === 'stopped') {
          client.close(4404, 'No such meeting')
          return
        }
        if (found.owner !== deps.userFromEmail(email).email) {
          client.close(4403, 'Not your meeting')
          return
        }
        session = found
        const set = clients.get(id) ?? new Set()
        // Like the server: one live connection per session; a newer one replaces the older.
        for (const previous of set) previous.close(4409, 'replaced by a newer connection')
        set.clear()
        clients.set(id, set.add(client))
        const ready: MeetingServerMessage = {
          type: 'ready',
          sessionId: id,
          resumeFrom: { ...found.received },
        }
        client.send(JSON.stringify(ready))
        client.send(JSON.stringify({ type: 'state', state: found.state }))
        return
      }
      if (typeof data === 'string') {
        let message: { type?: string; text?: unknown } = {}
        try {
          message = JSON.parse(data)
        } catch {
          return
        }
        if (message.type === 'notes' && typeof message.text === 'string') {
          session.rawNotes = message.text
        }
        if (message.type === 'pause') setState(session, 'paused')
        if (message.type === 'resume') setState(session, 'recording')
        return
      }
      if (data instanceof ArrayBuffer) onAudio(new Uint8Array(data))
      else if (ArrayBuffer.isView(data)) {
        onAudio(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
      } else if (data instanceof Blob) {
        void data.arrayBuffer().then((buffer) => onAudio(new Uint8Array(buffer)))
      }
    })
    client.addEventListener('close', () => {
      clearTimeout(timer)
      clients.get(id)?.delete(client)
    })
  })

  const handlers: AnyHandler[] = [
    socketHandler,

    http.get('/api/calendar/upcoming', async ({ request }) => {
      await wait()
      const user = principal(request)
      if (user instanceof Response) return user
      const url = new URL(request.url)
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const from = url.searchParams.get('from') ?? today.toISOString()
      const to =
        url.searchParams.get('to') ?? new Date(today.getTime() + 7 * 86_400_000).toISOString()
      return HttpResponse.json(meetings.upcoming(from, to))
    }),

    http.get('/api/calendar/status', async ({ request }) => {
      await wait()
      const user = principal(request)
      if (user instanceof Response) return user
      return HttpResponse.json({ ...meetings.calendarStatus })
    }),

    http.post('/api/calendar/refresh', async ({ request }) => {
      await wait()
      const user = principal(request)
      if (user instanceof Response) return user
      return HttpResponse.json(meetings.refreshCalendar())
    }),

    http.get('/api/calendar/match', async ({ request }) => {
      await wait()
      const user = principal(request)
      if (user instanceof Response) return user
      const meet = new URL(request.url).searchParams.get('meet') ?? ''
      return HttpResponse.json(meetings.match(meet, user.email))
    }),

    http.get('/api/calendar/coverage', async ({ request }) => {
      await wait()
      const user = principal(request)
      if (user instanceof Response) return user
      const url = new URL(request.url)
      const now = new Date()
      const from =
        url.searchParams.get('from') ?? new Date(now.getTime() - 14 * 86_400_000).toISOString()
      const to = url.searchParams.get('to') ?? now.toISOString()
      return HttpResponse.json(meetings.coverage(visible(user), user.email, from, to))
    }),

    http.get('/api/calendar/calendars', async ({ request }) => {
      await wait()
      const user = principal(request)
      if (user instanceof Response) return user
      return HttpResponse.json({ calendars: meetings.calendars(user.email) })
    }),

    http.put('/api/calendar/calendars', async ({ request }) => {
      await wait()
      const user = principal(request)
      if (user instanceof Response) return user
      const body = (await request.json().catch(() => ({}))) as { ids?: unknown }
      const ids = body.ids
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
        return error(400, 'bad_request', 'ids must be a list of calendar ids')
      }
      const calendars = meetings.setCalendars(user.email, ids)
      if (!calendars) return error(400, 'bad_request', 'Not one of your calendars')
      return HttpResponse.json({ calendars })
    }),

    http.get('/api/meetings/reminders', async () => {
      await wait()
      return HttpResponse.json({ publicKey: null })
    }),

    // The demo has no push service, so no browser is ever subscribed.
    http.post('/api/meetings/reminders/test', async ({ request }) => {
      await wait()
      const user = principal(request)
      if (user instanceof Response) return user
      return HttpResponse.json({ sent: 0, failed: 0 })
    }),

    http.get('/api/meetings/settings', async () => {
      await wait()
      return HttpResponse.json({ keepAudio: { available: true, byDefault: false } })
    }),

    http.get('/api/meetings/templates', async ({ request }) => {
      await wait()
      const user = principal(request)
      if (user instanceof Response) return user
      return HttpResponse.json(meetings.templates())
    }),

    // The mock keeps no checklist state; the home page hides the section when this is empty.
    http.get('/api/meetings/action-items', async ({ request }) => {
      await wait()
      const user = principal(request)
      if (user instanceof Response) return user
      return HttpResponse.json([])
    }),

    http.post('/api/meetings/action-items/done', async ({ request }) => {
      await wait()
      const user = principal(request)
      if (user instanceof Response) return user
      return HttpResponse.json({ ok: true })
    }),

    http.get('/api/meetings', async ({ request }) => {
      await wait()
      const user = principal(request)
      if (user instanceof Response) return user
      const params = new URL(request.url).searchParams
      const filters: MeetingFilters = {}
      for (const key of ['space', 'from', 'to', 'person', 'company', 'folder'] as const) {
        const value = params.get(key)
        if (value) filters[key] = value
      }
      return HttpResponse.json(meetings.list(visible(user), filters))
    }),

    http.post('/api/meetings/sessions', async ({ request }) => {
      await wait()
      const user = principal(request)
      if (user instanceof Response) return user
      const body = (await request.json().catch(() => ({}))) as CreateSessionBody
      return HttpResponse.json(meetings.view(meetings.create(user, body)))
    }),

    http.get('/api/meetings/sessions', async ({ request }) => {
      await wait()
      const user = principal(request)
      if (user instanceof Response) return user
      // Newest first; among sessions started the same millisecond, the later-created first.
      const unsaved = [...meetings.sessions.values()]
        .filter((s) => s.owner === user.email && s.state !== 'saved')
        .reverse()
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      return HttpResponse.json(unsaved.map((s) => meetings.view(s)))
    }),

    http.get('/api/meetings/sessions/:id', async ({ request, params }) => {
      const found = await owned(request, params.id)
      return found instanceof Response ? found : HttpResponse.json(meetings.view(found.session))
    }),

    http.put('/api/meetings/sessions/:id/notes', async ({ request, params }) => {
      const found = await owned(request, params.id)
      if (found instanceof Response) return found
      const { text } = (await request.json()) as { text: string }
      found.session.rawNotes = text
      return new HttpResponse(null, { status: 204 })
    }),

    http.put('/api/meetings/sessions/:id/keep-audio', async ({ request, params }) => {
      const found = await owned(request, params.id)
      if (found instanceof Response) return found
      if (found.session.state === 'stopped' || found.session.state === 'saved') {
        return error(409, 'conflict', 'This meeting has been stopped')
      }
      const { keep } = (await request.json()) as { keep: boolean }
      found.session.keepAudio = keep
      return HttpResponse.json(meetings.view(found.session))
    }),

    http.post('/api/meetings/sessions/:id/pause', async ({ request, params }) => {
      const found = await owned(request, params.id)
      if (found instanceof Response) return found
      setState(found.session, 'paused')
      return HttpResponse.json(meetings.view(found.session))
    }),

    http.post('/api/meetings/sessions/:id/resume', async ({ request, params }) => {
      const found = await owned(request, params.id)
      if (found instanceof Response) return found
      setState(found.session, 'recording')
      return HttpResponse.json(meetings.view(found.session))
    }),

    http.post('/api/meetings/sessions/:id/stop', async ({ request, params }) => {
      const found = await owned(request, params.id)
      if (found instanceof Response) return found
      if (found.session.state === 'saved') return error(409, 'conflict', 'Already stopped')
      const body = (await request.json().catch(() => ({}))) as { notes?: unknown }
      if (typeof body.notes === 'string') found.session.rawNotes = body.notes
      // Like the server: `stopped` goes out before the files are written, and stays if they fail.
      if (found.session.state !== 'stopped') setState(found.session, 'stopped')
      if (meetings.failStop) {
        return error(503, 'push_failed', 'Could not push the meeting to the Git host')
      }
      const result = meetings.stop(found.session.id, found.user)
      if (!result) return error(404, 'not_found', 'No such meeting session')
      deps.afterCommit(result.space, [result.path, result.transcriptPath])
      push(found.session.id, { type: 'state', state: 'saved' })
      return HttpResponse.json(result)
    }),

    http.post('/api/meetings/enhance', async ({ request }) => {
      await wait()
      const user = principal(request)
      if (user instanceof Response) return user
      const body = (await request.json()) as EnhanceBody
      if (!visible(user).includes(body.space)) {
        return error(403, 'forbidden', 'You cannot open this space')
      }
      // A language model takes a moment; let the "Enhancing" state show.
      if (deps.latencyMs > 0) await delay(deps.latencyMs * 10)
      const result = meetings.enhance(
        body.space,
        body.path,
        { template: body.template, force: body.force },
        { name: user.name, email: user.email },
      )
      if (result === 'edited') {
        return error(
          409,
          'edited_since_enhance',
          'This note was edited after it was enhanced. Enhancing again replaces those edits.',
        )
      }
      if (!result) return error(404, 'not_found', `No file at ${body.path}`)
      deps.afterCommit(body.space, [body.path])
      return HttpResponse.json(result)
    }),

    // Like the server, minus renaming on the note's AI lines: the transcript and the guesses.
    http.post('/api/meetings/speakers', async ({ request }) => {
      await wait()
      const user = principal(request)
      if (user instanceof Response) return user
      const body = (await request.json()) as {
        space: string
        path: string
        names: Record<string, string>
      }
      if (!visible(user).includes(body.space)) {
        return error(403, 'forbidden', 'You cannot open this space')
      }
      const space = deps.repo.space(body.space)
      const note = space.files.get(body.path)
      if (note === undefined) return error(404, 'not_found', `No file at ${body.path}`)
      const fm = parseFrontmatter(note).data
      const transcriptPath = transcriptPathFor(body.path, fm)
      const transcript = transcriptPath ? space.files.get(transcriptPath) : undefined
      if (!transcriptPath || transcript === undefined) {
        return error(400, 'bad_request', 'This meeting has no transcript')
      }
      const labels = new Set(parseTranscript(transcript).map((l) => l.speaker))
      for (const [from, to] of Object.entries(body.names)) {
        if (from === 'Me' || !labels.has(from) || !cleanSpeakerName(to)) {
          return error(400, 'bad_request', `“${from}” can’t be named “${to}”`)
        }
      }
      const guesses = Object.fromEntries(
        Object.entries((fm.speaker_guesses ?? {}) as Record<string, string>).filter(
          ([label]) => !Object.hasOwn(body.names, label),
        ),
      )
      space.commit(
        new Map([
          [
            body.path,
            patchFrontmatter(note, {
              speaker_guesses: Object.keys(guesses).length > 0 ? guesses : undefined,
            }),
          ],
          [transcriptPath, renameSpeakers(transcript, body.names)],
        ]),
        { name: user.name, email: user.email },
        `meetings: name speakers in "${String(fm.title ?? '')}"`,
      )
      deps.afterCommit(body.space, [body.path, transcriptPath])
      return HttpResponse.json({ transcriptPath, renamed: body.names })
    }),

    http.post('/api/meetings/chat', async ({ request }) => {
      await wait()
      const user = principal(request)
      if (user instanceof Response) return user
      const { question, scope } = (await request.json()) as { question: string; scope: ChatScope }
      if (deps.latencyMs > 0) await delay(deps.latencyMs * 6)
      return HttpResponse.json(meetings.chat(visible(user), question, scope ?? {}))
    }),
  ]

  return {
    handlers,
    dropSockets: (sessionId) => {
      for (const client of [...(clients.get(sessionId) ?? [])]) client.close(4000, 'dropped')
    },
  }
}
