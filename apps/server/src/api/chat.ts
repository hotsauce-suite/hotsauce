import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { HotsauceError } from '../errors.js'
import type { AppDeps, AppEnv } from './env.js'
import { valid } from './validate.js'

const adminOnly = (p: { isAdmin: boolean; via?: unknown }) => {
  if (!p.isAdmin || p.via) {
    throw new HotsauceError('forbidden', 'Only an admin can set up Claude in chat')
  }
}

const limitDelivery = bodyLimit({
  maxSize: 512 * 1024,
  onError: () => {
    throw new HotsauceError('bad_request', 'That delivery is too large', { status: 413 })
  },
})

/**
 * Searching the chat rooms read for context (docs/PLAN-chat-context.md R8). Every member may: a
 * room is only read when an admin says everyone in the workspace may read it.
 */
export function chatRoutes(
  deps: Pick<AppDeps, 'chatRooms' | 'chatReader' | 'chatClaude' | 'config'>,
) {
  const { chatRooms, chatReader, chatClaude, config } = deps
  const statusView = () => {
    const { webhookPath, ...rest } = chatClaude.status()
    return { ...rest, webhookUrl: `${config.PUBLIC_URL.replace(/\/+$/, '')}${webhookPath}` }
  }
  return (
    new Hono<AppEnv>()
      // The chat bot's webhook (docs/PLAN-chat-claude.md R1–R7): public, the secret is in the path.
      // What it answers is what the bot says back at once.
      .post('/webhooks/chat-claude/:secret', limitDelivery, async (c) => {
        if (!chatClaude.accepts(c.req.param('secret'))) {
          throw new HotsauceError('not_found', 'No such webhook')
        }
        let body: unknown
        try {
          body = await c.req.json()
        } catch {
          throw new HotsauceError('bad_request', 'Not a chat bot delivery')
        }
        const answer = await chatClaude.receive(body)
        return c.text(answer)
      })
      // Settings → Organization → Claude in chat (R8): admins only.
      .get('/chat/claude', (c) => {
        adminOnly(c.get('principal'))
        return c.json(statusView())
      })
      .put(
        '/chat/claude',
        valid(
          'json',
          z.object({
            routineId: z.string().max(100).optional(),
            token: z.string().max(400).nullable().optional(),
          }),
        ),
        (c) => {
          adminOnly(c.get('principal'))
          const { routineId, token } = c.req.valid('json')
          chatClaude.configure({
            ...(routineId !== undefined ? { routineId } : {}),
            ...(token !== undefined ? { token } : {}),
          })
          return c.json(statusView())
        },
      )
      .post('/chat/claude/new-address', (c) => {
        adminOnly(c.get('principal'))
        chatClaude.rotate()
        return c.json(statusView())
      })
      .delete('/chat/claude', (c) => {
        adminOnly(c.get('principal'))
        chatClaude.turnOff()
        return c.json(statusView())
      })
      .get(
        '/chat/search',
        valid(
          'query',
          z.object({
            q: z.string().max(500),
            limit: z.coerce.number().int().min(1).max(50).optional(),
          }),
        ),
        (c) => {
          const { q, limit } = c.req.valid('query')
          const rooms = chatRooms.readTargets()
          const names = new Map(rooms.map((r) => [r.id, r.name]))
          const hits = chatReader.store.search(q, {
            rooms: rooms.map((r) => r.id),
            ...(limit ? { limit } : {}),
          })
          return c.json(
            hits.map((h) => ({
              room: names.get(h.room) ?? '',
              id: h.id,
              author: h.author,
              createdAt: h.createdAt,
              snippet: h.snippet,
              url: h.url,
            })),
          )
        },
      )
  )
}
