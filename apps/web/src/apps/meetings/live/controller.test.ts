import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { HttpResponse, http } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { meetingsApi } from '../../../api/meetings'
import { mockApi, server } from '../../../test/mockServer'
import type { Capture } from '../audio/capture'
import { type Recorder, startRecorder } from '../audio/recorder'
import { AudioRing } from '../audio/ring-buffer'
import { skippedKey } from '../audio/socket'
import { beginLive, currentLive, notesDraftKey, unsentAudio } from './controller'
import { getLive } from './liveState'

globalThis.IDBKeyRange = IDBKeyRange

vi.mock('../audio/recorder', () => ({
  startRecorder: vi.fn(async () => ({ setPaused: vi.fn(), stop: vi.fn(async () => {}) })),
}))

const fakeCapture = (): Capture => ({
  mode: 'mic-only',
  streams: { me: {} as MediaStream },
  onEnded: () => () => {},
  stop: vi.fn(),
})

async function live(ring = new AudioRing({ factory: null })) {
  const session = await meetingsApi.createSession({ title: 'Controller' })
  return beginLive(session, { ring, minBackoffMs: 5 })
}

const fakeRecorder = (): Recorder => ({ setPaused: vi.fn(), stop: vi.fn(async () => {}) })

/** Dispatches beforeunload and reports whether the page asked to stay. */
function unloadPrompts(): boolean {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

afterEach(async () => {
  await currentLive()?.dispose()
})

describe('LiveMeeting', () => {
  it('asks before the tab closes only while it is capturing and recording', async () => {
    const meeting = await live()
    expect(unloadPrompts()).toBe(false)
    await meeting.attachCapture(fakeCapture())
    expect(getLive()?.capturing).toBe(true)
    expect(unloadPrompts()).toBe(true)
    await meeting.pause()
    expect(unloadPrompts()).toBe(false)
    await meeting.dispose()
    await meeting.resume().catch(() => {})
    expect(unloadPrompts()).toBe(false)
  })

  it('a failed Stop tears nothing down, so Stop can be tried again', async () => {
    const meeting = await live()
    meeting.setNotes('decided: ship Friday')
    server.use(
      http.post('/api/meetings/sessions/:id/stop', () =>
        HttpResponse.json(
          { error: { code: 'push_failed', message: 'Push failed' } },
          { status: 502 },
        ),
      ),
    )
    await expect(meeting.stop()).rejects.toThrow('Push failed')
    expect(currentLive()).toBe(meeting)
    expect(getLive()?.id).toBe(meeting.session.id)
    // The notes stay in this device's draft, and the retry carries them.
    expect(localStorage.getItem(notesDraftKey(meeting.session.id))).toBe('decided: ship Friday')

    server.resetHandlers(...mockApi().handlers)
    const saved = await meeting.stop()
    expect(saved.path).toMatch(/controller\.md$/)
    expect(
      mockApi().repo.space('ada').files.get(`.hearth/meetings/raw/${meeting.session.id}.md`),
    ).toBe('decided: ship Friday')
    expect(currentLive()).toBeNull()
    expect(getLive()).toBeNull()
  })

  it('its own Stop is never "stopped on another device", and a Stop that fails keeps everything for a retry', async () => {
    const ring = new AudioRing({ factory: null })
    const clear = vi.spyOn(ring, 'clear')
    const meeting = await live(ring)
    await vi.waitFor(() => expect(meeting.socket.status).toBe('live'))
    const api = mockApi()
    // What an earlier outage dropped from the ring goes with the ring, not before.
    localStorage.setItem(skippedKey(meeting.session.id), '{"me":3200,"them":0}')

    // The server says `stopped` before it commits; then the push fails.
    api.meetings.failStop = true
    await expect(meeting.stop()).rejects.toThrow('Could not push the meeting to the Git host')
    await vi.waitFor(() => expect(getLive()?.state).toBe('stopped'))
    expect(meeting.endedElsewhere).toBeNull()
    expect(currentLive()).toBe(meeting)
    expect(clear).not.toHaveBeenCalled()
    expect(localStorage.getItem(skippedKey(meeting.session.id))).not.toBeNull()

    api.meetings.failStop = false
    const saved = await meeting.stop()
    expect(saved.path).toMatch(/controller\.md$/)
    expect(meeting.endedElsewhere).toBeNull()
    expect(api.meetings.sessions.get(meeting.session.id)?.state).toBe('saved')
    expect(currentLive()).toBeNull()
    expect(clear).toHaveBeenCalledWith(meeting.session.id)
    expect(localStorage.getItem(skippedKey(meeting.session.id))).toBeNull()
  })

  describe('pause and resume while the socket is down', () => {
    /** A live meeting capturing through `recorder`, whose socket then drops for a while. */
    async function offline(recorder: Recorder, ring = new AudioRing({ factory: null })) {
      vi.mocked(startRecorder).mockResolvedValueOnce(recorder)
      const session = await meetingsApi.createSession({ title: 'Flaky network' })
      const meeting = beginLive(session, { ring, minBackoffMs: 150 })
      await meeting.attachCapture(fakeCapture())
      await vi.waitFor(() => expect(meeting.socket.status).toBe('live'))
      mockApi().dropMeetingSockets(session.id)
      await vi.waitFor(() => expect(meeting.socket.status).toBe('reconnecting'))
      const fake = mockApi().meetings.sessions.get(session.id)
      if (!fake) throw new Error('no session')
      return { meeting, fake }
    }

    it('Stop waits for audio recorded while the socket was down to reach the server', async () => {
      const ring = new AudioRing({ factory: new IDBFactory() })
      const { meeting, fake } = await offline(fakeRecorder(), ring)
      meeting.socket.sendAudio('me', new Uint8Array(3200).fill(7))
      let receivedAtStop = -1
      const onRequest = ({ request }: { request: Request }) => {
        if (new URL(request.url).pathname.endsWith('/stop')) receivedAtStop = fake.received.me
      }
      server.events.on('request:start', onRequest)
      await meeting.stop()
      server.events.removeListener('request:start', onRequest)
      expect(receivedAtStop).toBe(3200)
    })

    it('audio handed to a socket that then dropped is resent before Stop saves', async () => {
      mockApi().meetings.recordAudio = true
      const ring = new AudioRing({ factory: new IDBFactory() })
      vi.mocked(startRecorder).mockResolvedValueOnce(fakeRecorder())
      const session = await meetingsApi.createSession({ title: 'Dropped frames' })
      const meeting = beginLive(session, { ring, minBackoffMs: 150 })
      await meeting.attachCapture(fakeCapture())
      await vi.waitFor(() => expect(meeting.socket.status).toBe('live'))
      const fake = mockApi().meetings.sessions.get(session.id)
      if (!fake) throw new Error('no session')
      // Sent while live, then lost with the connection before the server counted it.
      meeting.socket.sendAudio('me', new Uint8Array(3200).fill(7))
      await vi.waitFor(() => expect(fake.received.me).toBe(3200))
      mockApi().dropMeetingSockets(session.id)
      fake.received.me = 0
      await vi.waitFor(() => expect(meeting.socket.status).toBe('reconnecting'))

      let receivedAtStop = -1
      const onRequest = ({ request }: { request: Request }) => {
        if (new URL(request.url).pathname.endsWith('/stop')) receivedAtStop = fake.received.me
      }
      server.events.on('request:start', onRequest)
      await meeting.stop()
      server.events.removeListener('request:start', onRequest)
      expect(receivedAtStop).toBe(3200)
    })

    it('when unsent audio can’t get through, the first Stop says so and the second saves', async () => {
      vi.mocked(startRecorder).mockResolvedValueOnce(fakeRecorder())
      const session = await meetingsApi.createSession({ title: 'Never back' })
      const meeting = beginLive(session, { minBackoffMs: 60_000, stopFlushMs: 100 })
      await meeting.attachCapture(fakeCapture())
      await vi.waitFor(() => expect(meeting.socket.status).toBe('live'))
      mockApi().dropMeetingSockets(session.id)
      await vi.waitFor(() => expect(meeting.socket.status).toBe('reconnecting'))
      meeting.socket.sendAudio('me', new Uint8Array(3200))

      await expect(meeting.stop()).rejects.toThrow(unsentAudio())
      expect(mockApi().meetings.sessions.get(session.id)?.state).not.toBe('saved')
      const saved = await meeting.stop()
      expect(saved.path).toMatch(/never-back/)
    })

    it('a pause that reached nothing holds on both sides once the socket is back', async () => {
      const recorder = fakeRecorder()
      const { meeting, fake } = await offline(recorder)
      server.use(http.post('/api/meetings/sessions/:id/pause', () => HttpResponse.error()))

      await meeting.pause()
      expect(getLive()?.state).toBe('paused')
      expect(recorder.setPaused).toHaveBeenLastCalledWith(true)
      expect(fake.state).toBe('recording')
      const before = vi.mocked(recorder.setPaused).mock.calls.length

      // The server says `recording` after `ready`; the re-sent pause wins without a blip.
      await vi.waitFor(() => expect(meeting.socket.status).toBe('live'))
      await vi.waitFor(() => expect(fake.state).toBe('paused'))
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(getLive()?.state).toBe('paused')
      expect(vi.mocked(recorder.setPaused).mock.calls.slice(before).flat()).not.toContain(false)
    })

    it('a pause that reached the server over HTTP is re-sent after ready, and earlier audio still counts', async () => {
      mockApi().meetings.recordAudio = true
      const ring = new AudioRing({ factory: new IDBFactory() })
      const { meeting, fake } = await offline(fakeRecorder(), ring)
      // Said just before the pause, while the socket was down: it waits in the ring.
      meeting.socket.sendAudio('me', new Uint8Array(3200).fill(7))
      const send = vi.spyOn(meeting.socket, 'send')

      await meeting.pause()
      expect(fake.state).toBe('paused')
      send.mockClear()
      await vi.waitFor(() => expect(meeting.socket.status).toBe('live'))
      expect(send).toHaveBeenCalledWith({ type: 'pause' })
      // The server counts audio that arrives while paused, so nothing is lost or resent.
      await vi.waitFor(() => expect(fake.received.me).toBe(3200))
      expect(fake.state).toBe('paused')
      expect(getLive()?.state).toBe('paused')
    })

    it('with no choice pending, the recorder follows the server: paused on another device', async () => {
      const recorder = fakeRecorder()
      vi.mocked(startRecorder).mockResolvedValueOnce(recorder)
      const meeting = await live()
      await meeting.attachCapture(fakeCapture())
      await vi.waitFor(() => expect(meeting.socket.status).toBe('live'))
      await new Promise((resolve) => setTimeout(resolve, 20))

      await meetingsApi.pause(meeting.session.id) // the other device
      await vi.waitFor(() => expect(getLive()?.state).toBe('paused'))
      expect(recorder.setPaused).toHaveBeenLastCalledWith(true)
    })
  })

  it('beginLive keeps one meeting per page', async () => {
    const first = await live()
    expect(beginLive(first.session)).toBe(first)
    const second = await live()
    expect(second).not.toBe(first)
    expect(currentLive()).toBe(second)
    expect(getLive()?.id).toBe(second.session.id)
  })

  it('lets go of the mic and the kept audio when the meeting is stopped on another device', async () => {
    const recorder = fakeRecorder()
    vi.mocked(startRecorder).mockResolvedValueOnce(recorder)
    const ring = new AudioRing({ factory: null })
    const clear = vi.spyOn(ring, 'clear')
    const meeting = await live(ring)
    const capture = fakeCapture()
    await meeting.attachCapture(capture)
    await vi.waitFor(() => expect(meeting.socket.status).toBe('live'))

    await meetingsApi.stop(meeting.session.id) // the other device
    await vi.waitFor(() => expect(currentLive()).toBeNull())
    expect(meeting.endedElsewhere).toMatch(/stopped elsewhere/)
    expect(getLive()).toBeNull()
    expect(capture.stop).toHaveBeenCalled()
    expect(recorder.stop).toHaveBeenCalled()
    expect(clear).toHaveBeenCalledWith(meeting.session.id)
  })

  it('ends the same way when the server no longer knows the session', async () => {
    const meeting = await live()
    await vi.waitFor(() => expect(meeting.socket.status).toBe('live'))
    mockApi().meetings.sessions.delete(meeting.session.id)
    mockApi().dropMeetingSockets(meeting.session.id)
    await vi.waitFor(() => expect(currentLive()).toBeNull())
    expect(meeting.endedElsewhere).toBe('No such meeting')
  })

  it('Keep audio reaches the server: the latest choice, and again after a failure', async () => {
    const meeting = await live()
    const fake = () => mockApi().meetings.sessions.get(meeting.session.id)
    meeting.setKeepAudio(true)
    meeting.setKeepAudio(false)
    await vi.waitFor(() => expect(fake()?.keepAudio).toBe(false))

    let refused = 0
    server.use(
      http.put(
        '/api/meetings/sessions/:id/keep-audio',
        () => {
          refused += 1
          return HttpResponse.json(
            { error: { code: 'unavailable', message: 'down' } },
            { status: 503 },
          )
        },
        { once: true },
      ),
    )
    meeting.setKeepAudio(true)
    await vi.waitFor(() => expect(fake()?.keepAudio).toBe(true), { timeout: 6_000 })
    expect(refused).toBe(1)

    // No answer at all, as when the network drops: tried again too.
    server.use(
      http.put('/api/meetings/sessions/:id/keep-audio', () => HttpResponse.error(), { once: true }),
    )
    meeting.setKeepAudio(false)
    await vi.waitFor(() => expect(fake()?.keepAudio).toBe(false), { timeout: 6_000 })
  }, 15_000)

  it('Stop sends the notepad’s text, even when the server holds an older copy', async () => {
    const meeting = await live()
    meeting.setNotes('final words')
    await vi.waitFor(() =>
      expect(mockApi().meetings.sessions.get(meeting.session.id)?.rawNotes).toBe('final words'),
    )
    // The server's copy falls behind (a late HTTP save landed over a newer socket one).
    const fake = mockApi().meetings.sessions.get(meeting.session.id)
    if (fake) fake.rawNotes = 'final'
    const saved = await meeting.stop()
    const raw = mockApi()
      .repo.space('ada')
      .files.get(`.hearth/meetings/raw/${meeting.session.id}.md`)
    expect(raw).toBe('final words')
    expect(saved.space).toBe('ada')
  })

  it('Stop carries the notepad’s text in its body, with no separate notes request', async () => {
    const session = await meetingsApi.createSession({ title: 'Offline notes' })
    // The socket is down and stays down: only the stop request can carry the notes.
    const meeting = beginLive(session, {
      ring: new AudioRing({ factory: null }),
      minBackoffMs: 60_000,
    })
    await vi.waitFor(() => expect(meeting.socket.status).toBe('live'))
    mockApi().dropMeetingSockets(session.id)
    await vi.waitFor(() => expect(meeting.socket.status).toBe('reconnecting'))
    const requests: Array<{ method: string; path: string; body: unknown }> = []
    server.events.on('request:start', async ({ request }) => {
      const path = new URL(request.url).pathname
      if (path.startsWith('/api/meetings/sessions/')) {
        requests.push({ method: request.method, path, body: await request.clone().json() })
      }
    })

    meeting.setNotes('typed while offline')
    await meeting.stop()
    expect(requests).toEqual([
      {
        method: 'POST',
        path: `/api/meetings/sessions/${session.id}/stop`,
        body: { notes: 'typed while offline' },
      },
    ])
    expect(mockApi().repo.space('ada').files.get(`.hearth/meetings/raw/${session.id}.md`)).toBe(
      'typed while offline',
    )
  })

  it('Stop sends unsent notes over the socket first, then the stop request', async () => {
    const meeting = await live()
    await vi.waitFor(() => expect(meeting.socket.status).toBe('live'))
    const order: string[] = []
    const send = meeting.socket.send.bind(meeting.socket)
    vi.spyOn(meeting.socket, 'send').mockImplementation((message) => {
      order.push(`frame ${JSON.stringify(message)}`)
      return send(message)
    })
    server.events.on('request:start', ({ request }) => {
      order.push(`${request.method} ${new URL(request.url).pathname.split('/').at(-1)}`)
    })

    meeting.setNotes('said just before Stop')
    await meeting.stop()
    expect(order).toEqual(['frame {"type":"notes","text":"said just before Stop"}', 'POST stop'])
  })

  it('after a reload, sends the draft this device kept if the server has less', async () => {
    const session = await meetingsApi.createSession({ title: 'Reloaded' })
    await meetingsApi.putNotes(session.id, 'agenda')
    localStorage.setItem(notesDraftKey(session.id), 'agenda\ntyped just before the reload')
    const meeting = beginLive(
      { ...session, rawNotes: 'agenda' },
      { ring: new AudioRing({ factory: null }) },
    )
    expect(meeting.notesText).toBe('agenda\ntyped just before the reload')
    await vi.waitFor(
      () =>
        expect(mockApi().meetings.sessions.get(session.id)?.rawNotes).toBe(
          'agenda\ntyped just before the reload',
        ),
      { timeout: 2000 },
    )
  })

  it('an attach overtaken by a newer one releases the capture and recorder it started', async () => {
    const meeting = await live()
    const slow = fakeRecorder()
    let finishSlow: () => void = () => {}
    vi.mocked(startRecorder).mockImplementationOnce(
      () => new Promise<Recorder>((resolve) => (finishSlow = () => resolve(slow))),
    )
    const first = fakeCapture()
    const second = fakeCapture()
    const attachFirst = meeting.attachCapture(first)
    await vi.waitFor(() => expect(startRecorder).toHaveBeenCalledTimes(1))
    await meeting.attachCapture(second)
    finishSlow()
    await attachFirst

    expect(first.stop).toHaveBeenCalled()
    expect(slow.stop).toHaveBeenCalled()
    expect(second.stop).not.toHaveBeenCalled()
    expect(getLive()?.capturing).toBe(true)
  })
})
