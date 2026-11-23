import { Hono } from 'hono'
import { z } from 'zod'
import { MAX_DRAFT_SOURCE } from '../slides/index.js'
import type { AppDeps, AppEnv } from './env.js'
import { valid } from './validate.js'

const DraftBody = z.object({
  title: z.string().trim().min(1).max(300),
  markdown: z.string().trim().min(1).max(MAX_DRAFT_SOURCE),
})

/** Slides (docs/PLAN-slides.md): an AI draft of a deck from a doc's text (R9). */
export function slideRoutes(deps: AppDeps) {
  return new Hono<AppEnv>().post('/slides/draft', valid('json', DraftBody), async (c) => {
    const markdown = await deps.slides.draft(c.get('principal').email, c.req.valid('json'))
    return c.json({ markdown })
  })
}
