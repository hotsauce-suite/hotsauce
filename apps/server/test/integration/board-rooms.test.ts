import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { newId } from '@hearth/format'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BoardRooms, MAX_BOARD_FRAME_BYTES, type RoomSocket } from '../../src/boards/index.js'
import { loadConfig } from '../../src/config.js'
import { createServices, type Services } from '../../src/services.js'
import { attachWebSocket } from '../../src/sync/index.js'
import { ALICE, makeTempDir, removeDir } from '../helpers/git.js'

// Live drawing together (ARCHITECTURE §15.5, plan W8): one room per board relays strokes and
// pointers between the people on it, only to people who can read the board's space.

const BOB = 'bob@example.test'
const ID = newId()

let root: string
let services: Services
let rooms: BoardRooms
let now = 1_000_000

beforeEach(async () => {
  root = await makeTempDir('hearth-rooms-')
  services = createServices(
    loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'dev',
      HOST_KIND: 'local',
      DATA_DIR: join(root, 'data'),
      LOCAL_HOST_DIR: join(root, 'remotes'),
    }),
  )
  await services.spaces.ensureTeamSpace()
  rooms = new BoardRooms({
    auth: services.auth,
    spaces: services.spaces,
    publicUrl: 'http://localhost:3000',
    authTimeoutMs: 100,
    heartbeatMs: 20,
    now: () => now,
  })
})

afterEach(async () => {
  rooms.stop()
  services.index.close()
  await removeDir(root)
})

class FakeSocket implements RoomSocket {
  readonly messages: Array<Record<string, unknown>> = []
  closed: { code: number; reason: string } | null = null
  pings = 0
  terminated = false
  buffered = 0
  bufferedAmount(): number {
    return this.buffered
  }
  send(data: string): void {
    this.messages.push(JSON.parse(data))
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason }
  }
  ping(): void {
    this.pings++
  }
  terminate(): void {
    this.terminated = true
  }
  of(type: string) {
    return this.messages.filter((m) => m.type === type)
  }
}

async function enter(devUser: string, space = 'team', id = ID) {
  const socket = new FakeSocket()
  const handlers = rooms.connect(space, id, socket)
  handlers.text(JSON.stringify({ type: 'auth', devUser }))
  await vi.waitFor(() => expect(socket.messages.length > 0 || socket.closed).toBeTruthy())
  return { socket, handlers }
}

const rect = (id: string, version: number) => ({ id, type: 'rectangle', version, x: 1, y: 2 })

describe('board rooms', () => {
  it('W8: relays strokes and pointers to the others on the board, with who sent them', async () => {
    const a = await enter(ALICE.email)
    expect(a.socket.messages[0]).toMatchObject({ type: 'ready', peers: [] })
    const aliceId = (a.socket.messages[0] as { you: { id: string } }).you.id
    const b = await enter(BOB)
    expect(b.socket.messages[0]).toMatchObject({
      type: 'ready',
      peers: [{ id: aliceId, email: ALICE.email }],
    })
    expect(a.socket.of('join')).toEqual([
      { type: 'join', peer: expect.objectContaining({ email: BOB }) },
    ])

    a.handlers.text(JSON.stringify({ type: 'scene', elements: [rect('r1', 2)] }))
    a.handlers.text(JSON.stringify({ type: 'pointer', x: 10, y: 20, button: 'down' }))
    expect(b.socket.of('scene')).toEqual([
      { type: 'scene', from: aliceId, elements: [rect('r1', 2)] },
    ])
    expect(b.socket.of('pointer')).toEqual([
      { type: 'pointer', from: aliceId, x: 10, y: 20, button: 'down' },
    ])
    // Nothing comes back to the sender.
    expect(a.socket.of('scene')).toEqual([])
    expect(rooms.size('team', ID)).toBe(2)

    b.handlers.closed()
    expect(a.socket.of('leave')).toHaveLength(1)
    expect(rooms.size('team', ID)).toBe(1)
  })

  it('keeps boards apart', async () => {
    const a = await enter(ALICE.email)
    const other = await enter(BOB, 'team', newId())
    a.handlers.text(JSON.stringify({ type: 'scene', elements: [rect('r1', 1)] }))
    expect(other.socket.of('scene')).toEqual([])
  })

  it('refuses someone who cannot read the space, a bad id, and no sign-in', async () => {
    // A personal space is its owner's only; one that isn't Bob's (or doesn't exist) is refused.
    const bob = await enter(BOB, 'alice')
    expect(bob.socket.closed?.code).toBe(4403)
    expect(bob.socket.messages).toEqual([])

    const bad = await enter(ALICE.email, 'team', '../etc')
    expect(bad.socket.closed?.code).toBe(4403)

    const anon = new FakeSocket()
    rooms.connect('team', ID, anon).text(JSON.stringify({ type: 'auth' }))
    await vi.waitFor(() => expect(anon.closed?.code).toBe(4401))

    const silent = new FakeSocket()
    rooms.connect('team', ID, silent)
    await vi.waitFor(() => expect(silent.closed?.code).toBe(4401))
  })

  it('closes a peer that sends junk or too much, and drops a flood past the rate', async () => {
    const a = await enter(ALICE.email)
    const b = await enter(BOB)
    for (let i = 0; i < 200; i++) a.handlers.text(JSON.stringify({ type: 'pointer', x: i, y: 0 }))
    expect(b.socket.of('pointer').length).toBe(120)
    now += 1000
    a.handlers.text(JSON.stringify({ type: 'pointer', x: 1, y: 1 }))
    expect(b.socket.of('pointer').length).toBe(121)

    a.handlers.text(JSON.stringify({ type: 'scene', elements: [{ id: 'x' }] }))
    expect(a.socket.closed?.code).toBe(1008)
    expect(b.socket.of('leave')).toHaveLength(1)

    const c = await enter(ALICE.email)
    c.handlers.text('x'.repeat(MAX_BOARD_FRAME_BYTES + 1))
    expect(c.socket.closed?.code).toBe(1009)
  })

  it('refuses iframe elements and broken geometry, and stops relaying a peer it closed', async () => {
    const a = await enter(ALICE.email)
    const b = await enter(BOB)
    a.handlers.text(
      JSON.stringify({
        type: 'scene',
        elements: [{ id: 'f', type: 'iframe', version: 1, customData: { html: '<script>' } }],
      }),
    )
    expect(a.socket.closed?.code).toBe(1008)
    a.handlers.text(JSON.stringify({ type: 'scene', elements: [rect('r1', 1)] }))
    expect(b.socket.of('scene')).toEqual([])

    const c = await enter(ALICE.email)
    c.handlers.text(
      JSON.stringify({
        type: 'scene',
        elements: [{ id: 'd', type: 'freedraw', version: 1, points: 5 }],
      }),
    )
    expect(c.socket.closed?.code).toBe(1008)
  })

  it('caps bytes per second and skips a receiver that is far behind', async () => {
    const a = await enter(ALICE.email)
    const b = await enter(BOB)
    const big = { type: 'scene', elements: [{ ...rect('r', 1), pad: 'x'.repeat(200_000) }] }
    for (let i = 0; i < 20; i++) a.handlers.text(JSON.stringify(big))
    expect(b.socket.of('scene').length).toBeLessThan(12)
    now += 1000
    b.socket.buffered = 5 * 1024 * 1024
    a.handlers.text(JSON.stringify({ type: 'pointer', x: 1, y: 1 }))
    expect(b.socket.of('pointer')).toEqual([])
  })

  it('survives a sign-in that is not a valid header, and refuses a big first message', async () => {
    for (const bad of [
      { type: 'auth', token: 'a\nb' },
      { type: 'auth', devUser: 'x\r\ny' },
    ]) {
      const socket = new FakeSocket()
      rooms.connect('team', ID, socket).text(JSON.stringify(bad))
      await vi.waitFor(() => expect(socket.closed?.code).toBe(4401))
    }
    const big = new FakeSocket()
    rooms.connect('team', ID, big).text('x'.repeat(17 * 1024))
    expect(big.closed?.code).toBe(1009)
  })

  it('sends a catch-up only to the one who joined, and who joins even to a slow receiver', async () => {
    const a = await enter(ALICE.email)
    const b = await enter(BOB)
    b.socket.buffered = 5 * 1024 * 1024
    const c = await enter(ALICE.email)
    expect(b.socket.of('join')).toHaveLength(1)
    const cId = (c.socket.messages[0] as { you: { id: string } }).you.id
    a.handlers.text(JSON.stringify({ type: 'scene', to: cId, elements: [rect('r1', 1)] }))
    expect(c.socket.of('scene')).toEqual([
      { type: 'scene', from: expect.any(String), elements: [rect('r1', 1)] },
    ])
    b.socket.buffered = 0
    expect(b.socket.of('scene')).toEqual([])
  })

  it('drops a peer that stops answering pings', async () => {
    const a = await enter(ALICE.email)
    rooms.start()
    await vi.waitFor(() => expect(a.socket.terminated).toBe(true))
    expect(rooms.size('team', ID)).toBe(0)
  })

  it('works over a real socket at /ws/boards/:space/:id', async () => {
    const app = new Hono()
    const inject = attachWebSocket(app, services.broadcaster, undefined, undefined, rooms)
    const server = serve({ fetch: app.fetch, port: 0 })
    inject(server)
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve))
    const { port } = server.address() as AddressInfo
    const open = async (devUser: string) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/boards/team/${ID}`)
      const got: Array<Record<string, unknown>> = []
      ws.addEventListener('message', (e) => got.push(JSON.parse(String(e.data))))
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve)
        ws.addEventListener('error', reject)
      })
      ws.send(JSON.stringify({ type: 'auth', devUser }))
      await vi.waitFor(() => expect(got[0]).toMatchObject({ type: 'ready' }))
      return { ws, got }
    }
    try {
      const a = await open(ALICE.email)
      const b = await open(BOB)
      a.ws.send(JSON.stringify({ type: 'scene', elements: [rect('r9', 3)] }))
      await vi.waitFor(() =>
        expect(b.got.at(-1)).toMatchObject({ type: 'scene', elements: [rect('r9', 3)] }),
      )
      a.ws.close()
      b.ws.close()
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
