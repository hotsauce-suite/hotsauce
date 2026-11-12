import { Hono } from 'hono'
import { z } from 'zod'
import { FEEDBACK_KINDS } from '../feedback/index.js'
import type { AppDeps, AppEnv } from './env.js'
import { sessionOnly } from './tokens.js'
import { valid } from './validate.js'

const Text = z.string().trim().min(1).max(5000)
const Answers = z
  .array(z.object({ question: z.string().max(500), answer: z.string().max(2000) }))
  .max(10)
  .default([])

/**
 * Send feedback (docs/plans/2026-11-12-feedback.md). Session only: an access token can't file,
 * so a leaked token can't flood the board.
 */
export function feedbackRoutes(deps: Pick<AppDeps, 'feedback'>) {
  const service = deps.feedback
  return new Hono<AppEnv>()
    .basePath('/feedback')
    .get('/status', (c) => c.json({ enabled: service.enabled }))
    .post(
      '/clarify',
      valid(
        'json',
        z.object({
          kind: z.enum(FEEDBACK_KINDS),
          text: Text,
          answers: Answers,
          round: z.number().int().min(0).max(10).default(0),
        }),
      ),
      async (c) => {
        const principal = sessionOnly(c.get('principal'))
        return c.json(await service.clarify(principal, c.req.valid('json')))
      },
    )
    .post(
      '/',
      valid(
        'json',
        z.object({
          kind: z.enum(FEEDBACK_KINDS),
          text: Text,
          answers: Answers,
          title: z.string().max(200).optional(),
          summary: z.string().max(4000).optional(),
          context: z
            .object({
              page: z.string().max(500).optional(),
              app: z.string().max(100).optional(),
              browser: z.string().max(500).optional(),
            })
            .default({}),
        }),
      ),
      async (c) => {
        const principal = sessionOnly(c.get('principal'))
        return c.json(await service.submit(principal, c.req.valid('json')), 201)
      },
    )
    .get('/mine', async (c) => {
      const principal = sessionOnly(c.get('principal'))
      return c.json({ items: await service.mine(principal) })
    })
    .post(
      '/:number/reply',
      valid('param', z.object({ number: z.coerce.number().int().positive() })),
      valid('json', z.object({ text: Text })),
      async (c) => {
        const principal = sessionOnly(c.get('principal'))
        await service.reply(principal, c.req.valid('param').number, c.req.valid('json').text)
        return c.json({ ok: true })
      },
    )
}
