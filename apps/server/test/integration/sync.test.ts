import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { createServices, type Services } from '../../src/services.js'
import {
  attachWebSocket,
  Broadcaster,
  type ClientSocket,
  Poller,
  type SyncEvent,
  Syncer,
  WS_UNAUTHORIZED,
} from '../../src/sync/index.js'
import { ALICE, makeTempDir, OutsideEditor, removeDir } from '../helpers/git.js'

const BOB = { name: 'Bob', email: 'bob@example.test' }

let root: string
let services: Services
let broadcaster: Broadcaster
let syncer: Syncer

beforeEach(async () => {
  root = await makeTempDir('hearth-sync-')
  services = createServices(
    loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'dev',
      HOST_KIND: 'local',
      DATA_DIR: join(root, 'data'),
      LOCAL_HOST_DIR: join(root, 'remotes'),
    }),
  )
  broadcaster = new Broadcaster({
    auth: services.auth,
    spaces: services.spaces,
    publicUrl: 'http://localhost:3000',
    authTimeoutMs: 100,
    heartbeatMs: 20,
  })
  syncer = new Syncer({ ...services, broadcaster })
  await services.spaces.ensureTeamSpace()
  await syncer.afterHeadChanged('team')
})

afterEach(async () => {
  broadcaster.stop()
  services.index.close()
  await removeDir(root)
})

/** Stands in for a WebSocket; records what the broadcaster does to it. */
class FakeSocket implements ClientSocket {
  readonly messages: Array<SyncEvent | { type: 'ready' }> = []
  closed: { code: number; reason: string } | null = null
  pings = 0
  terminated = false
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
}

async function connect(devUser: string) {
  const socket = new FakeSocket()
  const connection = broadcaster.connect(socket)
  connection.receive(JSON.stringify({ type: 'auth', devUser }))
  await vi.waitFor(() => expect(socket.messages).toEqual([{ type: 'ready' }]))
  return { socket, connection }
}

async function outside(space: string): Promise<OutsideEditor> {
  const { cloneUrl } = await services.host.ensureRepo(space)
  return OutsideEditor.clone(cloneUrl, join(root, `outside-${space}`))
}

describe('Syncer', () => {
  it('indexes an outside push and broadcasts changed to a connected client', async () => {
    const { socket } = await connect(ALICE.email)
    const editor = await outside('team')
    const pushed = await editor.push({ 'docs/from-outside.md': '# From outside\n\nHello.\n' })

    await syncer.syncSpace('team')

    expect(services.index.getFile('team', 'docs/from-outside.md')?.title).toBe('From outside')
    expect(services.index.getSyncState('team')?.headOid).toBe(pushed)
    expect(socket.messages.slice(1)).toEqual([
      { type: 'changed', space: 'team', headOid: pushed, paths: ['docs/from-outside.md'] },
    ])

    // Nothing new: no event.
    await syncer.syncSpace('team')
    expect(socket.messages).toHaveLength(2)
  })

  it('removes deleted files from the index', async () => {
    const editor = await outside('team')
    await editor.push({ 'docs/brief.md': '# Brief\n' })
    await syncer.syncSpace('team')
    await editor.push({ 'docs/brief.md': null })
    await syncer.syncSpace('team')
    expect(services.index.getFile('team', 'docs/brief.md')).toBeNull()
  })

  it('indexes outside pushes that a Hearth commit fast-forwarded over', async () => {
    const editor = await outside('team')
    await editor.push({ 'docs/outside.md': '# Outside\n' })
    // commit() catches up with origin first, so a later sync sees nothing new.
    await services.git.commit('team', {
      changes: [{ path: 'docs/mine.md', content: '# Mine\n' }],
      author: ALICE,
      message: 'docs: create "Mine"',
    })

    await syncer.afterHeadChanged('team')

    expect(services.index.getFile('team', 'docs/outside.md')?.title).toBe('Outside')
    expect(services.index.getFile('team', 'docs/mine.md')?.title).toBe('Mine')
  })

  it('announces conflicts that appear during a sync, once', async () => {
    const { socket } = await connect(ALICE.email)
    const ref = await services.git.branchConflict('team', 'docs/a.md', 'ours\n', ALICE)

    await syncer.syncSpace('team')
    await syncer.syncSpace('team')

    expect(socket.messages.slice(1)).toEqual([
      { type: 'conflict', space: 'team', path: 'docs/a.md', ref },
    ])
    expect(services.index.listConflicts('team').map((c) => c.ref)).toEqual([ref])
  })
})

describe('Broadcaster', () => {
  it('closes a client that never authenticates with 4401, and sends it nothing', async () => {
    const socket = new FakeSocket()
    broadcaster.connect(socket)
    broadcaster.broadcast({ type: 'changed', space: 'team', headOid: 'x', paths: [] })
    await vi.waitFor(() => expect(socket.closed?.code).toBe(WS_UNAUTHORIZED))
    expect(socket.messages).toEqual([])
  })

  it('closes a client whose credential is bad, or outside the domain, with 4401', async () => {
    for (const message of [
      'not json',
      JSON.stringify({ type: 'auth', devUser: 'visitor@example.com' }),
      JSON.stringify({ type: 'auth', token: 'a-clerk-token-in-dev-mode' }),
      JSON.stringify({ type: 'hello' }),
    ]) {
      const socket = new FakeSocket()
      broadcaster.connect(socket).receive(message)
      await vi.waitFor(() =>
        expect(socket.closed).toEqual({ code: WS_UNAUTHORIZED, reason: 'unauthorized' }),
      )
      expect(socket.messages).toEqual([])
    }
  })

  it('sends each event only to clients that can access its space', async () => {
    await services.spaces.ensurePersonalSpace({
      userId: 'dev:alice',
      email: ALICE.email,
      name: ALICE.name,
      handle: 'alice',
      isAdmin: false,
    })
    const alice = await connect(ALICE.email)
    const bob = await connect(BOB.email)

    const personal: SyncEvent = { type: 'changed', space: 'alice', headOid: 'a', paths: ['x.md'] }
    const team: SyncEvent = { type: 'conflict', space: 'team', path: 'docs/y.md', ref: 'r' }
    broadcaster.broadcast(personal)
    broadcaster.broadcast(team)

    expect(alice.socket.messages.slice(1)).toEqual([personal, team])
    expect(bob.socket.messages.slice(1)).toEqual([team])
  })

  it('pings on a heartbeat and drops clients that stop answering', async () => {
    const answers = await connect(ALICE.email)
    const silent = await connect(BOB.email)
    const pong = setInterval(() => answers.connection.pong(), 5)
    try {
      broadcaster.start()
      await vi.waitFor(() => expect(silent.socket.terminated).toBe(true))
      expect(answers.socket.pings).toBeGreaterThan(0)
      expect(answers.socket.terminated).toBe(false)
      broadcaster.broadcast({ type: 'changed', space: 'team', headOid: 'h', paths: [] })
      expect(answers.socket.messages).toHaveLength(2)
      expect(silent.socket.messages).toHaveLength(1)
    } finally {
      clearInterval(pong)
    }
  })
})

describe('Poller', () => {
  it('never overlaps passes, keeps going after a failing space, and stops cleanly', async () => {
    const running = new Set<string>()
    let overlapped = false
    const synced: string[] = []
    const log: string[] = []
    const poller = new Poller({
      syncer: {
        async syncSpace(space) {
          // The same space twice at once would mean two passes overlapping.
          if (running.has(space)) overlapped = true
          running.add(space)
          await new Promise((resolve) => setTimeout(resolve, 15))
          running.delete(space)
          if (space === 'broken') throw new Error('host down')
          synced.push(space)
        },
      },
      spaces: () => ['broken', 'team'],
      intervalMs: 1,
      log: (m) => log.push(m),
    })

    poller.start()
    await vi.waitFor(() => expect(synced.length).toBeGreaterThanOrEqual(3))
    await poller.stop()
    const after = synced.length
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(synced.length).toBe(after)
    expect(overlapped).toBe(false)
    expect(log[0]).toBe('sync of broken failed: host down')
  })

  it('syncs a pass’s spaces a few at a time, so many members don’t slow every space', async () => {
    let running = 0
    let maxRunning = 0
    const synced: string[] = []
    const spaces = Array.from({ length: 20 }, (_, i) => `space-${i}`)
    const poller = new Poller({
      syncer: {
        async syncSpace(space) {
          running++
          maxRunning = Math.max(maxRunning, running)
          await new Promise((resolve) => setTimeout(resolve, 20))
          running--
          synced.push(space)
        },
      },
      spaces: () => spaces,
      intervalMs: 60_000,
      concurrency: 4,
    })
    const started = Date.now()
    await poller.pollOnce()
    expect(synced.sort()).toEqual([...spaces].sort())
    expect(maxRunning).toBe(4)
    // Five rounds of 20 ms, not twenty.
    expect(Date.now() - started).toBeLessThan(300)
  })
})

describe('/ws over a real socket', () => {
  /** An HTTP server with only /ws on it, as main.ts wires it; closed after `use`. */
  async function withServer(
    use: (wsUrl: string) => Promise<void>,
    opts: { meetings?: boolean } = {},
  ): Promise<void> {
    const app = new Hono()
    const inject = attachWebSocket(
      app,
      broadcaster,
      opts.meetings ? services.meetings.sockets : undefined,
    )
    const server = serve({ fetch: app.fetch, port: 0 })
    inject(server)
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve))
    const { port } = server.address() as AddressInfo
    try {
      await use(`ws://127.0.0.1:${port}/ws`)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  }

  it('handshakes with a dev user, then delivers events', async () => {
    await withServer(async (wsUrl) => {
      const ws = new WebSocket(wsUrl)
      const received: unknown[] = []
      ws.addEventListener('message', (e) => received.push(JSON.parse(String(e.data))))
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve)
        ws.addEventListener('error', reject)
      })
      ws.send(JSON.stringify({ type: 'auth', devUser: ALICE.email }))
      await vi.waitFor(() => expect(received).toEqual([{ type: 'ready' }]))

      const event: SyncEvent = { type: 'changed', space: 'team', headOid: 'h', paths: ['a.md'] }
      broadcaster.broadcast(event)
      await vi.waitFor(() => expect(received).toEqual([{ type: 'ready' }, event]))
      ws.close()
    })
  })

  it('closes with 4401 when the first message is not a valid auth', async () => {
    await withServer(async (wsUrl) => {
      const ws = new WebSocket(wsUrl)
      const closed = new Promise<number>((resolve) =>
        ws.addEventListener('close', (e) => resolve(e.code)),
      )
      ws.addEventListener('open', () =>
        ws.send(JSON.stringify({ type: 'auth', devUser: 'x@example.com' })),
      )
      expect(await closed).toBe(WS_UNAUTHORIZED)
    })
  })

  it('closes with 1009 on a frame over 16 KiB, before it reaches authentication', async () => {
    const authenticate = vi.spyOn(services.auth, 'authenticate')
    await withServer(async (wsUrl) => {
      const ws = new WebSocket(wsUrl)
      const received: unknown[] = []
      ws.addEventListener('message', (e) => {
        received.push(e.data)
        ws.close()
      })
      const closed = new Promise<number>((resolve) =>
        ws.addEventListener('close', (e) => resolve(e.code)),
      )
      // A valid auth message padded to 20 KiB: it would authenticate if it were let through.
      const auth = JSON.stringify({ type: 'auth', devUser: ALICE.email, pad: 'x'.repeat(20_480) })
      ws.addEventListener('open', () => ws.send(auth))
      expect(await closed).toBe(1009)
      expect(received).toEqual([])
      expect(authenticate).not.toHaveBeenCalled()
    })
  })

  it('keeps the 16 KiB cap on /ws when meeting audio raises the server-wide frame limit', async () => {
    const authenticate = vi.spyOn(services.auth, 'authenticate')
    await withServer(
      async (wsUrl) => {
        const ws = new WebSocket(wsUrl)
        const closed = new Promise<number>((resolve) =>
          ws.addEventListener('close', (e) => resolve(e.code)),
        )
        const auth = JSON.stringify({ type: 'auth', devUser: ALICE.email, pad: 'x'.repeat(20_480) })
        ws.addEventListener('open', () => ws.send(auth))
        expect(await closed).toBe(1009)
        expect(authenticate).not.toHaveBeenCalled()
      },
      { meetings: true },
    )
  })
})
