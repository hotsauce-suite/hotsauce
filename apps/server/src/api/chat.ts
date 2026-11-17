import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps, AppEnv } from './env.js'
import { valid } from './validate.js'

/**
 * Searching the chat rooms read for context (docs/PLAN-chat-context.md R8). Every member may: a
 * room is only read when an admin says everyone in the workspace may read it.
 */
export function chatRoutes(deps: Pick<AppDeps, 'chatRooms' | 'chatReader'>) {
  const { chatRooms, chatReader } = deps
  return new Hono<AppEnv>().get(
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
}
