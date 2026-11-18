import { MAX_THEME_NAME, MAX_THEME_PROMPT, Theme } from '@hotsauce/format'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppDeps, AppEnv } from './env.js'
import { valid } from './validate.js'

const Prompt = z.string().trim().min(1).max(MAX_THEME_PROMPT)
const Name = z.string().trim().min(1).max(MAX_THEME_NAME)
const Id = z.object({ id: z.string().regex(/^[0-9A-Z]{26}$/) })

/**
 * A member's own themes (docs/PLAN-ai-themes.md). Every route acts on the caller's themes only;
 * another member's id is simply not found.
 */
export function themeRoutes(deps: AppDeps) {
  const { themes } = deps
  return new Hono<AppEnv>()
    .get('/themes', (c) =>
      c.json({
        themes: themes.list(c.get('principal').email),
        canGenerate: themes.canGenerate,
      }),
    )
    .post(
      '/themes/generate',
      valid('json', z.object({ prompt: Prompt, base: Theme.optional() })),
      async (c) => {
        const { prompt, base } = c.req.valid('json')
        const theme = await themes.generate(c.get('principal').email, prompt, base)
        return c.json({ theme })
      },
    )
    .post(
      '/themes',
      valid(
        'json',
        z.object({ name: Name, prompt: z.string().max(MAX_THEME_PROMPT), theme: Theme }),
      ),
      (c) => c.json({ theme: themes.save(c.get('principal').email, c.req.valid('json')) }),
    )
    .patch('/themes/:id', valid('param', Id), valid('json', z.object({ name: Name })), (c) => {
      themes.rename(c.get('principal').email, c.req.valid('param').id, c.req.valid('json').name)
      return c.json({ ok: true as const })
    })
    .delete('/themes/:id', valid('param', Id), (c) => {
      themes.remove(c.get('principal').email, c.req.valid('param').id)
      return c.json({ ok: true as const })
    })
}
