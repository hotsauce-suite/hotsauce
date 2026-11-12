import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { AppDeps } from '../../api/env.js'
import type { Principal } from '../../auth/index.js'
import type { ClipView } from '../../clips/index.js'
import { READ_ONLY, runTool } from '../result.js'

export type ClipToolDeps = Pick<AppDeps, 'clips' | 'config'>

const Instant = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'an ISO date or time')

/**
 * Hearth Clips (ARCHITECTURE §10, §8.2): the same clips the member sees in the web app. Every
 * member's finished clips are visible to the team; another member's clip still recording is not.
 * Metadata, summary and transcript only: never video bytes or playback URLs.
 */
export function registerClipTools(server: McpServer, deps: ClipToolDeps, principal: Principal) {
  const { clips } = deps
  const base = deps.config.PUBLIC_URL.replace(/\/+$/, '')
  const pageUrl = (id: string) => `${base}/clips/${encodeURIComponent(id)}`
  const summary = (c: ClipView) => ({
    id: c.id,
    title: c.title,
    owner: c.owner,
    isOwner: c.isOwner,
    createdAt: c.createdAt,
    durationSeconds: c.durationMs === null ? null : Math.round(c.durationMs / 1000),
    status: c.status,
    summary: c.summary,
    transcriptStatus: c.transcriptStatus,
    url: pageUrl(c.id),
  })

  server.registerTool(
    'list_clips',
    {
      title: 'List clips',
      description:
        'Screen recordings (Clips) you can see, newest first: yours and your teammates’ finished ones. Each has a title, owner, length, AI summary and a link to watch it.',
      inputSchema: {
        query: z
          .string()
          .max(200)
          .optional()
          .describe('Words to match in the title, summary or transcript'),
        from: Instant.optional().describe('Only clips recorded at or after this'),
        to: Instant.optional().describe('Only clips recorded before this'),
        mine: z.boolean().optional().describe('Only your own clips; default false'),
        limit: z.number().int().min(1).max(100).optional().describe('Default 25'),
      },
      annotations: READ_ONLY,
    },
    ({ query, from, to, mine, limit }) =>
      runTool(async () => {
        const found = await clips.list(principal, {
          scope: mine ? 'mine' : 'team',
          q: query,
          from: from ? new Date(from).toISOString() : undefined,
          to: to ? new Date(to).toISOString() : undefined,
          limit: limit ?? 25,
        })
        return found.map(summary)
      }),
  )

  server.registerTool(
    'get_clip',
    {
      title: 'Get a clip',
      description:
        'A clip’s details, AI summary, link, and its transcript as timestamped lines ([m:ss] text). Use it to answer questions about what a recording showed or said.',
      inputSchema: { id: z.string().min(1).describe('The clip id from list_clips') },
      annotations: READ_ONLY,
    },
    ({ id }) =>
      runTool(async () => {
        const { clip, transcript } = await clips.get(principal, id)
        return {
          ...summary(clip),
          transcript:
            clip.transcriptStatus === 'ready'
              ? transcript.map((s) => `[${clock(s.start)}] ${s.text}`).join('\n')
              : null,
        }
      }),
  )
}

/** Seconds as m:ss (h:mm:ss past an hour). */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}
