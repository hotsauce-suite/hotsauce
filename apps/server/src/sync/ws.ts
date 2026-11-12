import { createNodeWebSocket, type NodeWebSocket } from '@hono/node-ws'
import type { Hono } from 'hono'
import type { BoardRooms } from '../boards/rooms.js'
import type { DictationSocketServer } from '../dictation/socket.js'
import { MAX_MEETING_FRAME_BYTES, type MeetingSocketServer } from '../meetings/socket.js'
import type { Broadcaster, Connection } from './broadcaster.js'
import { MAX_AUTH_FRAME_BYTES } from './handshake.js'

const WS_TOO_BIG = 1009

/**
 * Adds `GET /ws` to `app`, handing each socket to the broadcaster, and `GET /ws/meetings/:id`
 * for meeting audio when `meetings` is given. Returns the function that attaches the upgrade
 * handler to the HTTP server once it exists.
 */
export function attachWebSocket(
  app: Hono,
  broadcaster: Broadcaster,
  meetings?: MeetingSocketServer,
  dictation?: DictationSocketServer,
  boards?: BoardRooms,
): NodeWebSocket['injectWebSocket'] {
  const { injectWebSocket, upgradeWebSocket, wss } = createNodeWebSocket({ app })
  // Anyone can open a socket: cap frames well below ws's 100 MiB default (a bigger one closes the
  // socket with 1009). ws reads this at upgrade, for every route, so with meeting audio it is the
  // audio limit and /ws enforces its own smaller one below.
  wss.options.maxPayload =
    meetings || dictation || boards ? MAX_MEETING_FRAME_BYTES : MAX_AUTH_FRAME_BYTES
  if (dictation) {
    // Hearth Dictate's audio stream (ARCHITECTURE §9.2); a device token in the first message.
    app.get(
      '/ws/dictation',
      upgradeWebSocket(() => {
        let handlers: ReturnType<DictationSocketServer['connect']> | undefined
        return {
          onOpen(_event, ws) {
            const socket = ws.raw
            if (!socket) return
            handlers = dictation.connect({
              send: (data) => socket.send(data),
              close: (code, reason) => socket.close(code, reason),
            })
          },
          onMessage(event) {
            if (typeof event.data === 'string') handlers?.text(event.data)
            else if (event.data instanceof ArrayBuffer) handlers?.binary(new Uint8Array(event.data))
          },
          onClose() {
            handlers?.closed()
          },
        }
      }),
    )
  }
  if (boards) {
    // Live drawing on one board (ARCHITECTURE §15.5); the auth message first, as on /ws.
    app.get(
      '/ws/boards/:space/:id',
      upgradeWebSocket((c) => {
        const space = c.req.param('space') ?? ''
        const id = c.req.param('id') ?? ''
        let handlers: ReturnType<BoardRooms['connect']> | undefined
        return {
          onOpen(_event, ws) {
            const socket = ws.raw
            if (!socket) return
            handlers = boards.connect(space, id, {
              send: (data) => socket.send(data),
              bufferedAmount: () => socket.bufferedAmount,
              close: (code, reason) => socket.close(code, reason),
              ping: () => socket.ping(),
              terminate: () => socket.terminate(),
            })
            socket.on('pong', () => handlers?.pong())
          },
          onMessage(event, ws) {
            if (typeof event.data !== 'string') {
              ws.close(1003, 'text only')
              return
            }
            handlers?.text(event.data)
          },
          onClose() {
            handlers?.closed()
          },
        }
      }),
    )
  }
  app.get(
    '/ws',
    upgradeWebSocket(() => {
      let connection: Connection | undefined
      return {
        onOpen(_event, ws) {
          const socket = ws.raw
          if (!socket) return
          connection = broadcaster.connect({
            send: (data) => socket.send(data),
            close: (code, reason) => socket.close(code, reason),
            ping: () => socket.ping(),
            terminate: () => socket.terminate(),
          })
          socket.on('pong', () => connection?.pong())
        },
        onMessage(event, ws) {
          // Clients only ever send the auth message.
          if (typeof event.data !== 'string') return
          if (Buffer.byteLength(event.data) > MAX_AUTH_FRAME_BYTES) {
            ws.close(WS_TOO_BIG, 'frame too large')
            return
          }
          connection?.receive(event.data)
        },
        onClose() {
          connection?.closed()
        },
      }
    }),
  )
  if (meetings) {
    app.get(
      '/ws/meetings/:id',
      upgradeWebSocket((c) => {
        const id = c.req.param('id') ?? ''
        let handlers: ReturnType<MeetingSocketServer['connect']> | undefined
        return {
          onOpen(_event, ws) {
            const socket = ws.raw
            if (!socket) return
            handlers = meetings.connect(id, {
              send: (data) => socket.send(data),
              close: (code, reason) => socket.close(code, reason),
              ping: () => socket.ping(),
              terminate: () => socket.terminate(),
            })
            socket.on('pong', () => handlers?.pong())
          },
          onMessage(event) {
            if (typeof event.data === 'string') handlers?.text(event.data)
            else if (event.data instanceof ArrayBuffer) handlers?.binary(new Uint8Array(event.data))
          },
          onClose() {
            handlers?.closed()
          },
        }
      }),
    )
  }
  return injectWebSocket
}
