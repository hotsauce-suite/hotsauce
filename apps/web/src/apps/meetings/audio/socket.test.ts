import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { ws } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { meetingsApi } from '../../../api/meetings'
import type { MeetingSession, TranscriptSegment } from '../../../api/types'
import { mockApi, server } from '../../../test/mockServer'
import { AudioRing } from './ring-buffer'
import { applySegment, decodeAudioFrame, encodeAudioFrame, MeetingSocket } from './socket'

globalThis.IDBKeyRange = IDBKeyRange

const FRAME = 3200
const frame = (fill: number) => new Uint8Array(FRAME).fill(fill)
const seg = (
  track: 'me' | 'them',
  at: number,
  text: string,
  final: boolean,
): TranscriptSegment => ({
  track,
  speaker: track === 'me' ? 'Me' : 'Them',
  at,
  durationMs: 1000,
  text,
  final,
})

/**
 * The ring's contract in memory, with IndexedDB's timing: a write is visible to reads only
 * once its transaction commits, a few milliseconds after `append` is called.
 */
class SlowRing extends AudioRing {
  private readonly chunks: Array<{ track: string; offset: number; bytes: Uint8Array }> = []

  constructor(private readonly keepBytes = Infinity) {
    super({ factory: null })
  }

  override async append(_id: string, track: 'me' | 'them', offset: number, bytes: Uint8Array) {
    await new Promise((resolve) => setTimeout(resolve, 3))
    this.chunks.push({ track, offset, bytes: bytes.slice() })
    const end = offset + bytes.byteLength
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const c = this.chunks[i]
      if (c && c.track === track && c.offset + c.bytes.byteLength <= end - this.keepBytes) {
        this.chunks.splice(i, 1)
      }
    }
  }

  override async read(_id: string, track: 'me' | 'them', from: number, to = Infinity) {
    await new Promise((resolve) => setTimeout(resolve, 1))
    return this.chunks
      .filter((c) => c.track === track && c.offset + c.bytes.byteLength > from && c.offset < to)
      .sort((a, b) => a.offset - b.offset)
      .map((c) => {
        const start = Math.max(c.offset, from)
        const stop = Math.min(c.offset + c.bytes.byteLength, to)
        return { offset: start, bytes: c.bytes.subarray(start - c.offset, stop - c.offset) }
      })
  }

  override async end(_id: string, track: 'me' | 'them') {
    const ends = this.chunks.filter((c) => c.track === track).map((c) => c.offset + c.bytes.length)
    return Math.max(0, ...ends)
  }
}

let sockets: MeetingSocket[] = []

function openSocket(
  session: MeetingSession,
  ring = new AudioRing({ factory: new IDBFactory() }),
  minBackoffMs = 5,
) {
  const socket = new MeetingSocket({ sessionId: session.id, ring, minBackoffMs })
  sockets.push(socket)
  return socket
}

afterEach(() => {
  for (const socket of sockets) socket.stop()
  sockets = []
})

describe('audio frames', () => {
  it('prefix the PCM with the track byte: 0 for me, 1 for them', () => {
    const pcm = Uint8Array.from([7, 8, 9])
    expect([...encodeAudioFrame('me', pcm)]).toEqual([0, 7, 8, 9])
    expect([...encodeAudioFrame('them', pcm)]).toEqual([1, 7, 8, 9])
    const decoded = decodeAudioFrame(encodeAudioFrame('them', pcm))
    expect(decoded?.track).toBe('them')
    expect([...(decoded?.pcm ?? [])]).toEqual([7, 8, 9])
    expect(decodeAudioFrame(Uint8Array.from([5, 1]))).toBeNull()
  })
})

describe('applySegment', () => {
  it('replaces the track’s partial in place, then settles it with the final', () => {
    let list = applySegment([], seg('me', 0, 'hel', false))
    list = applySegment(list, seg('them', 0, 'yes', false))
    list = applySegment(list, seg('me', 0, 'hello', false))
    expect(list.map((s) => s.text)).toEqual(['hello', 'yes'])
    list = applySegment(list, seg('me', 0, 'hello there', true))
    expect(list).toEqual([seg('me', 0, 'hello there', true), seg('them', 0, 'yes', false)])
    // The next partial on the track is a new line.
    list = applySegment(list, seg('me', 1000, 'and', false))
    expect(list).toHaveLength(3)
  })

  it('replaces a replayed final instead of repeating it', () => {
    const once = applySegment([seg('me', 0, 'hello', true)], seg('me', 0, 'hello', true))
    expect(once).toHaveLength(1)
  })
})

describe('MeetingSocket', () => {
  it('authenticates with its first message and sends no audio before ready', async () => {
    const session = await meetingsApi.createSession({ title: 'Order check' })
    const received: Array<string | number> = []
    const link = ws.link(`ws://localhost:3000/ws/meetings/${session.id}`)
    // This handler alone answers the socket.
    server.resetHandlers(
      link.addEventListener('connection', ({ client }) => {
        client.addEventListener('message', (event) => {
          if (typeof event.data === 'string') {
            received.push(event.data)
            // Answer the auth late, so any early audio would show up before "ready".
            if (received.length === 1) {
              setTimeout(() => {
                received.push('ready')
                client.send(
                  JSON.stringify({
                    type: 'ready',
                    sessionId: session.id,
                    resumeFrom: { me: 0, them: 0 },
                  }),
                )
              }, 30)
            }
          } else {
            received.push((event.data as Uint8Array).byteLength)
          }
        })
      }),
    )
    const socket = openSocket(session)
    socket.sendAudio('me', frame(1))
    socket.start()
    socket.sendAudio('them', frame(2))
    await vi.waitFor(() => expect(received).toHaveLength(4))
    expect(JSON.parse(String(received[0]))).toEqual({
      type: 'auth',
      devUser: 'morgan@example.test',
    })
    expect(received[1]).toBe('ready')
    // Both frames captured before "ready" went out after it, from the ring.
    expect(received.slice(2)).toEqual([FRAME + 1, FRAME + 1])
    expect(socket.send({ type: 'notes', text: 'hi' })).toBe(true)
  })

  it('streams segments: a partial at half a second, replaced by the final', async () => {
    const session = await meetingsApi.createSession({ title: 'Segments' })
    const socket = openSocket(session)
    const transcripts: Array<readonly TranscriptSegment[]> = []
    socket.on('transcript', (list) => transcripts.push(list))
    socket.start()
    await vi.waitFor(() => expect(socket.status).toBe('live'))

    for (let i = 0; i < 5; i++) socket.sendAudio('me', frame(1))
    await vi.waitFor(() => expect(socket.transcript).toHaveLength(1))
    expect(socket.transcript[0]).toMatchObject({ text: 'me segment 1', final: false })

    for (let i = 0; i < 5; i++) socket.sendAudio('me', frame(1))
    for (let i = 0; i < 10; i++) socket.sendAudio('them', frame(2))
    await vi.waitFor(() =>
      expect(socket.transcript.map((s) => [s.track, s.text, s.final])).toEqual([
        ['me', 'me segment 1', true],
        ['them', 'them segment 1', true],
      ]),
    )
    expect(transcripts.at(-1)).toBe(socket.transcript)
  })

  it('reconnects and resends exactly what the server is missing, from resumeFrom', async () => {
    const api = mockApi()
    api.meetings.recordAudio = true
    const session = await meetingsApi.createSession({ title: 'Flaky network' })
    const socket = openSocket(session, undefined, 150)
    const statuses: string[] = []
    socket.on('status', (s) => statuses.push(s))
    socket.start()
    await vi.waitFor(() => expect(socket.status).toBe('live'))

    for (let i = 1; i <= 5; i++) socket.sendAudio('me', frame(i))
    const fake = api.meetings.sessions.get(session.id)
    await vi.waitFor(() => expect(fake?.received.me).toBe(5 * FRAME))

    // The last two frames never made it, and the connection drops.
    api.meetings.loseTail(session.id, 'me', 2 * FRAME)
    api.dropMeetingSockets(session.id)
    // Audio captured while offline waits in the ring.
    await vi.waitFor(() => expect(socket.status).toBe('reconnecting'))
    socket.sendAudio('me', frame(6))
    expect(fake?.received.me).toBe(3 * FRAME)

    await vi.waitFor(() => expect(fake?.received.me).toBe(6 * FRAME))
    expect(statuses).toContain('reconnecting')
    expect(socket.status).toBe('live')
    const expected = [1, 2, 3, 4, 5, 6].flatMap((i) => [...frame(i)])
    expect(fake?.audio.me).toEqual(expected)
  })

  it('after a reload, carries on from where the ring ends', async () => {
    const api = mockApi()
    api.meetings.recordAudio = true
    const session = await meetingsApi.createSession({ title: 'Reload' })
    const ring = new AudioRing({ factory: new IDBFactory() })
    const first = openSocket(session, ring)
    first.start()
    await vi.waitFor(() => expect(first.status).toBe('live'))
    first.sendAudio('me', frame(1))
    first.sendAudio('me', frame(2))
    const fake = api.meetings.sessions.get(session.id)
    await vi.waitFor(() => expect(fake?.received.me).toBe(2 * FRAME))
    first.stop()
    // The second frame was lost with the page.
    api.meetings.loseTail(session.id, 'me', FRAME)

    const second = openSocket(session, ring)
    second.start()
    second.sendAudio('me', frame(3))
    await vi.waitFor(() => expect(fake?.received.me).toBe(3 * FRAME))
    expect(fake?.audio.me).toEqual([1, 2, 3].flatMap((i) => [...frame(i)]))
  })

  it('loses nothing captured while it catches up, though ring writes commit late', async () => {
    const api = mockApi()
    api.meetings.recordAudio = true
    const session = await meetingsApi.createSession({ title: 'Busy reconnect' })
    const socket = openSocket(session, new SlowRing(), 30)
    socket.start()
    await vi.waitFor(() => expect(socket.status).toBe('live'))
    const fake = api.meetings.sessions.get(session.id)

    // A frame every 2 ms for a while, straddling a drop, the reconnect and the catch-up.
    let n = 0
    const timer = setInterval(() => {
      n += 1
      socket.sendAudio('me', frame(n % 250))
    }, 2)
    await new Promise((resolve) => setTimeout(resolve, 40))
    api.dropMeetingSockets(session.id)
    await vi.waitFor(() => expect(socket.status).toBe('live'))
    await new Promise((resolve) => setTimeout(resolve, 60))
    clearInterval(timer)

    const expected = Array.from({ length: n }, (_, i) => [...frame((i + 1) % 250)]).flat()
    await vi.waitFor(() => expect(fake?.received.me).toBe(n * FRAME))
    expect(fake?.audio.me).toEqual(expected)
  })

  it('after a gap older than the ring keeps, later reconnects send nothing twice', async () => {
    const api = mockApi()
    api.meetings.recordAudio = true
    const session = await meetingsApi.createSession({ title: 'Long outage' })
    // The ring keeps two frames per track.
    const socket = openSocket(session, new SlowRing(2 * FRAME), 60)
    socket.start()
    await vi.waitFor(() => expect(socket.status).toBe('live'))
    const fake = api.meetings.sessions.get(session.id)

    api.dropMeetingSockets(session.id)
    await vi.waitFor(() => expect(socket.status).toBe('reconnecting'))
    for (let i = 1; i <= 5; i++) socket.sendAudio('me', frame(i))
    // Only the last two frames survive in the ring; they go out after the reconnect.
    await vi.waitFor(() => expect(fake?.received.me).toBe(2 * FRAME))
    expect(fake?.audio.me).toEqual([4, 5].flatMap((i) => [...frame(i)]))

    api.dropMeetingSockets(session.id)
    await vi.waitFor(() => expect(socket.status).toBe('reconnecting'))
    await vi.waitFor(() => expect(socket.status).toBe('live'))
    socket.sendAudio('me', frame(6))
    await vi.waitFor(() => expect(fake?.received.me).toBe(3 * FRAME))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(fake?.audio.me).toEqual([4, 5, 6].flatMap((i) => [...frame(i)]))
  })

  it('after a reload, remembers what the ring dropped, so it resends nothing the server has', async () => {
    const api = mockApi()
    api.meetings.recordAudio = true
    const session = await meetingsApi.createSession({ title: 'Outage, then reload' })
    // The ring keeps two frames per track.
    const ring = new SlowRing(2 * FRAME)
    const first = openSocket(session, ring, 60)
    first.start()
    await vi.waitFor(() => expect(first.status).toBe('live'))
    const fake = api.meetings.sessions.get(session.id)

    api.dropMeetingSockets(session.id)
    await vi.waitFor(() => expect(first.status).toBe('reconnecting'))
    for (let i = 1; i <= 5; i++) first.sendAudio('me', frame(i))
    // Frames 1-3 fell out of the ring during the outage; 4 and 5 went out after it.
    await vi.waitFor(() => expect(fake?.received.me).toBe(2 * FRAME))
    first.stop()

    // The page reloads: a new socket over the same ring and the same browser storage.
    const second = openSocket(session, ring)
    second.start()
    await vi.waitFor(() => expect(second.status).toBe('live'))
    second.sendAudio('me', frame(6))
    await vi.waitFor(() => expect(fake?.received.me).toBe(3 * FRAME))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(fake?.audio.me).toEqual([4, 5, 6].flatMap((i) => [...frame(i)]))
  })

  it('stops for good when the server refuses the session', async () => {
    const session = await meetingsApi.createSession({ title: 'Not mine' })
    mockApi().meetings.sessions.delete(session.id)
    const socket = openSocket(session)
    const errors: string[] = []
    socket.on('error', (e) => errors.push(e))
    socket.start()
    await vi.waitFor(() => expect(socket.status).toBe('closed'))
    expect(errors).toEqual(['No such meeting'])
  })

  it('gives up, without reconnecting, when a newer connection takes the session over', async () => {
    const session = await meetingsApi.createSession({ title: 'Two tabs' })
    const first = openSocket(session)
    const errors: string[] = []
    first.on('error', (e) => errors.push(e))
    first.start()
    await vi.waitFor(() => expect(first.status).toBe('live'))

    const second = openSocket(session)
    second.start()
    await vi.waitFor(() => expect(second.status).toBe('live'))

    // The server closes the older socket with 4409; reconnecting would only steal it back.
    await vi.waitFor(() => expect(first.status).toBe('closed'))
    expect(errors).toEqual(['Another tab or device is recording this meeting now.'])
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(first.status).toBe('closed')
    expect(second.status).toBe('live')
  })
})
