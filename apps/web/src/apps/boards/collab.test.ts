import type { BoardElement } from '@hearth/format'
import { describe, expect, it } from 'vitest'
import { BoardCollab, type CollabSocket, type Peer, type PointerUpdate } from './collab'

function el(id: string, version: number): BoardElement {
  return { id, type: 'rectangle', version, versionNonce: 1 }
}

class FakeSocket implements CollabSocket {
  readyState = 0
  sent: Array<Record<string, unknown>> = []
  closed = false
  readonly #listeners: Record<string, Array<(e: { data: unknown; code?: number }) => void>> = {}
  addEventListener(type: string, fn: (e: { data: unknown; code?: number }) => void): void {
    this.#listeners[type] = [...(this.#listeners[type] ?? []), fn]
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }
  close(): void {
    this.closed = true
    this.readyState = 3
    this.emit('close')
  }
  emit(type: string, data?: unknown, code?: number): void {
    for (const fn of this.#listeners[type] ?? []) fn(code === undefined ? { data } : { data, code })
  }
  /** The server closed it with a code. */
  shut(code: number): void {
    this.readyState = 3
    this.emit('close', undefined, code)
  }
  open(): void {
    this.readyState = 1
    this.emit('open')
  }
  server(msg: unknown): void {
    this.emit('message', JSON.stringify(msg))
  }
  of(type: string) {
    return this.sent.filter((m) => m.type === type)
  }
}

function harness() {
  const sockets: FakeSocket[] = []
  const timers: Array<{ fn: () => void; ms: number; done: boolean }> = []
  const got = {
    scenes: [] as Array<{ elements: BoardElement[]; from: string }>,
    pointers: [] as Array<{ from: string; p: PointerUpdate }>,
    peers: [] as Peer[][],
  }
  const collab = new BoardCollab(
    'ws://x/ws/boards/team/B',
    {
      open: () => {
        const s = new FakeSocket()
        sockets.push(s)
        return s
      },
      auth: async () => ({ type: 'auth', devUser: 'a@example.test' }),
      setTimer: (fn, ms) => {
        const t = { fn, ms, done: false }
        timers.push(t)
        return t
      },
      clearTimer: (t) => {
        ;(t as { done: boolean }).done = true
      },
    },
    {
      scene: (elements, from) => got.scenes.push({ elements, from }),
      pointer: (from, p) => got.pointers.push({ from, p }),
      peers: (p) => got.peers.push(p),
    },
  )
  const tick = () => {
    for (const t of timers.splice(0)) if (!t.done) t.fn()
  }
  const socket = () => sockets.at(-1) as FakeSocket
  async function connect(peers: Peer[] = []) {
    socket().open()
    await Promise.resolve()
    await Promise.resolve()
    socket().server({ type: 'ready', you: { id: 'me' }, peers })
  }
  return { collab, sockets, socket, timers, tick, got, connect }
}

const bob: Peer = { id: 'p2', name: 'Bob', email: 'bob@example.test' }

describe('BoardCollab', () => {
  it('signs in with the first message, then sends only what changed, batched', async () => {
    const h = harness()
    h.collab.start([el('a', 1)])
    await h.connect([bob])
    expect(h.socket().sent[0]).toEqual({ type: 'auth', devUser: 'a@example.test' })
    expect(h.got.peers.at(-1)).toEqual([bob])

    h.collab.changed([el('a', 1), el('b', 1)])
    h.collab.changed([el('a', 2), el('b', 1)])
    h.tick()
    expect(h.socket().of('scene')).toEqual([{ type: 'scene', elements: [el('a', 2), el('b', 1)] }])
    h.collab.changed([el('a', 2), el('b', 1)])
    h.tick()
    expect(h.socket().of('scene')).toHaveLength(1)
  })

  it('never echoes what others drew', async () => {
    const h = harness()
    h.collab.start([])
    await h.connect([bob])
    h.socket().server({ type: 'scene', from: 'p2', elements: [el('t', 3)] })
    expect(h.got.scenes).toEqual([{ elements: [el('t', 3)], from: 'p2' }])
    h.collab.seen([el('t', 3)])
    h.collab.changed([el('t', 3)])
    h.tick()
    expect(h.socket().of('scene')).toEqual([])
  })

  it('alone on a board it sends nothing, then catches up whoever joins', async () => {
    const h = harness()
    h.collab.start([])
    await h.connect([])
    h.collab.changed([el('a', 1)])
    h.collab.pointer({ x: 1, y: 1 })
    h.tick()
    expect(h.socket().of('scene')).toEqual([])
    expect(h.socket().of('pointer')).toEqual([])
    h.socket().server({ type: 'join', peer: bob })
    h.tick()
    expect(h.socket().of('scene')).toEqual([{ type: 'scene', elements: [el('a', 1)] }])
  })

  it('throttles pointer moves and passes on others’ pointers and leaving', async () => {
    const h = harness()
    h.collab.start([])
    await h.connect([bob])
    h.collab.pointer({ x: 1, y: 1 })
    h.collab.pointer({ x: 2, y: 2 })
    h.collab.pointer({ x: 3, y: 3, button: 'down' })
    expect(h.socket().of('pointer')).toEqual([{ type: 'pointer', x: 1, y: 1 }])
    h.tick()
    expect(h.socket().of('pointer').at(-1)).toEqual({ type: 'pointer', x: 3, y: 3, button: 'down' })
    h.socket().server({ type: 'pointer', from: 'p2', x: 5, y: 6 })
    expect(h.got.pointers).toEqual([{ from: 'p2', p: { x: 5, y: 6 } }])
    h.socket().server({ type: 'leave', id: 'p2' })
    expect(h.got.peers.at(-1)).toEqual([])
  })

  it('splits a big change under the frame limit', async () => {
    const h = harness()
    h.collab.start([])
    await h.connect([bob])
    const big = Array.from({ length: 30 }, (_, i) => ({
      ...el(`f${i}`, 1),
      points: Array.from({ length: 1000 }, (_, j) => [j, j]),
    }))
    h.collab.changed(big)
    h.tick()
    const batches = h.socket().of('scene')
    expect(batches.length).toBeGreaterThan(1)
    for (const b of batches) expect(JSON.stringify(b).length).toBeLessThan(256 * 1024)
    expect(batches.flatMap((b) => (b.elements as BoardElement[]).map((e) => e.id))).toHaveLength(30)
  })

  it('reconnects with backoff and stops on close', async () => {
    const h = harness()
    h.collab.start([])
    await h.connect([bob])
    h.socket().close()
    expect(h.got.peers.at(-1)).toEqual([])
    expect(h.timers.at(-1)?.ms).toBe(1000)
    h.tick()
    expect(h.sockets).toHaveLength(2)
    h.collab.close()
    expect(h.socket().closed).toBe(true)
    h.tick()
    expect(h.sockets).toHaveLength(2)
  })

  it('stops for good when refused, and waits long when the board is full', async () => {
    for (const code of [4403, 1008, 1009]) {
      const h = harness()
      h.collab.start([])
      await h.connect([bob])
      h.socket().shut(code)
      expect(h.timers.filter((t) => !t.done && t.ms >= 1000)).toEqual([])
    }
    const h = harness()
    h.collab.start([])
    await h.connect([bob])
    h.socket().shut(1013)
    expect(h.timers.at(-1)?.ms).toBe(30_000)
  })

  it('a joiner gets what was drawn since the last save, even if already sent', async () => {
    const h = harness()
    h.collab.start([el('old', 1)])
    await h.connect([bob])
    h.collab.changed([el('old', 1), el('a', 1)])
    h.tick()
    expect(h.socket().of('scene')).toHaveLength(1)
    const carol: Peer = { id: 'p3', name: 'Carol', email: 'c@example.test' }
    h.socket().server({ type: 'join', peer: carol })
    h.tick()
    expect(h.socket().of('scene').at(-1)).toEqual({
      type: 'scene',
      elements: [el('a', 1)],
      to: 'p3',
    })
    // Once saved, a later joiner reads it from the save.
    h.collab.saved()
    h.socket().server({ type: 'join', peer: { ...carol, id: 'p4' } })
    h.tick()
    expect(h.socket().of('scene')).toHaveLength(2)
  })

  it('never sends or hands on iframe elements, and counts batches in bytes', async () => {
    const h = harness()
    h.collab.start([])
    await h.connect([bob])
    h.socket().server({
      type: 'scene',
      from: 'p2',
      elements: [{ id: 'f', type: 'iframe', version: 1 }, el('r', 1)],
    })
    expect(h.got.scenes).toEqual([{ elements: [el('r', 1)], from: 'p2' }])
    const wide = (id: string) => ({ ...el(id, 1), text: '漢'.repeat(30_000) })
    h.collab.changed([{ id: 'f2', type: 'iframe', version: 1 }, wide('w1'), wide('w2'), wide('w3')])
    h.tick()
    const batches = h.socket().of('scene')
    expect(batches.flatMap((b) => (b.elements as BoardElement[]).map((e) => e.id))).toEqual([
      'w1',
      'w2',
      'w3',
    ])
    for (const b of batches)
      expect(new TextEncoder().encode(JSON.stringify(b)).length).toBeLessThan(256 * 1024)
  })

  it('passes on the laser pointer', async () => {
    const h = harness()
    h.collab.start([])
    await h.connect([bob])
    h.socket().server({ type: 'pointer', from: 'p2', x: 1, y: 2, tool: 'laser', button: 'x' })
    expect(h.got.pointers).toEqual([{ from: 'p2', p: { x: 1, y: 2, tool: 'laser' } }])
  })
})
