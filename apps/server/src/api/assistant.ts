import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import type { AssistantEvent } from '../assistant/agent.js'
import { DEFAULT_ASSISTANT_MODEL } from '../assistant/index.js'
import { ASSISTANT_MODELS } from '../assistant/pricing.js'
import { MAX_QUESTION_CHARS } from '../assistant/service.js'
import { monthOf } from '../assistant/store.js'
import { HearthError } from '../errors.js'
import type { AppDeps, AppEnv } from './env.js'
import { valid } from './validate.js'

const Id = z.string().regex(/^[0-9A-Za-z_-]{8,64}$/, 'Invalid id')

const Ask = z.object({
  text: z.string().min(1).max(MAX_QUESTION_CHARS),
  context: z
    .object({
      space: z.string().min(1).max(200),
      path: z.string().min(1).max(1000),
      title: z.string().max(300),
    })
    .optional(),
  tz: z.string().max(100).optional(),
})

/** The built-in assistant (docs/PLAN-assistant.md). Each member sees only their own conversations. */
export function assistantRoutes(deps: Pick<AppDeps, 'assistant' | 'config' | 'org'>) {
  const { assistant, config, org } = deps
  const settingsView = () => {
    const saved = org.settings()
    return {
      model: config.ASSISTANT_MODEL ?? (saved.assistantModel || DEFAULT_ASSISTANT_MODEL),
      monthlyLimitUsd: config.ASSISTANT_MONTHLY_LIMIT_USD ?? saved.assistantMonthlyLimitUsd,
      models: ASSISTANT_MODELS,
      // A value set in the environment wins over Settings, so the page shows it read-only.
      fromEnv: {
        model: config.ASSISTANT_MODEL !== undefined,
        monthlyLimitUsd: config.ASSISTANT_MONTHLY_LIMIT_USD !== undefined,
      },
    }
  }
  const adminOnly = (p: { isAdmin: boolean; via?: unknown }, what: string) => {
    if (!p.isAdmin || p.via) throw new HearthError('forbidden', `Only an admin can ${what}`)
  }
  return (
    new Hono<AppEnv>()
      .basePath('/assistant')
      .get('/', (c) =>
        c.json({
          name: assistant.name(),
          configured: config.LLM_PROVIDER !== 'none',
        }),
      )
      .get('/conversations', (c) =>
        c.json({ conversations: assistant.store.list(c.get('principal').userId) }),
      )
      .get('/conversations/:id', valid('param', z.object({ id: Id })), (c) => {
        const conv = assistant.store.get(c.get('principal').userId, c.req.valid('param').id)
        if (!conv) throw new HearthError('not_found', 'No such conversation')
        const { messages: _hidden, ...shown } = conv
        return c.json(shown)
      })
      .delete('/conversations/:id', valid('param', z.object({ id: Id })), (c) => {
        const gone = assistant.store.delete(c.get('principal').userId, c.req.valid('param').id)
        if (!gone) throw new HearthError('not_found', 'No such conversation')
        return c.body(null, 204)
      })
      /** Answers as Server-Sent Events: text, tool, tool_result, confirm, then done or error. */
      .post(
        '/conversations/:id/messages',
        valid('param', z.object({ id: Id })),
        valid('json', Ask),
        (c) => {
          const principal = c.get('principal')
          const { id } = c.req.valid('param')
          const body = c.req.valid('json')
          // Refusals that need no model call answer as plain HTTP errors, before the stream.
          if (config.LLM_PROVIDER === 'none') {
            throw new HearthError(
              'not_configured',
              'The assistant needs an Anthropic API key. An admin can add one in Settings.',
            )
          }
          assistant.checkAllowance(principal)
          return streamSSE(c, async (stream) => {
            const abort = new AbortController()
            stream.onAbort(() => abort.abort())
            // Writes go out in order, and all of them before the stream closes.
            let pending: Promise<void> = Promise.resolve()
            const send = (event: AssistantEvent) => {
              pending = pending.then(() =>
                stream.writeSSE({ event: event.type, data: JSON.stringify(event) }),
              )
            }
            // A comment line every 15 seconds keeps proxies from closing a quiet stream while a
            // long tool runs; the browser ignores it.
            const keepalive = setInterval(() => {
              pending = pending.then(() => stream.write(': ping\n\n')).then(() => {})
            }, 15_000)
            try {
              await assistant.ask(
                principal,
                { conversationId: id, text: body.text, context: body.context, tz: body.tz },
                send,
                abort.signal,
              )
            } catch (err) {
              if (abort.signal.aborted) return
              if (!(err instanceof HearthError)) console.error('assistant: ask failed:', err)
              const message =
                err instanceof HearthError ? err.message : 'Something went wrong; try again.'
              send({ type: 'error', message })
            } finally {
              clearInterval(keepalive)
            }
            await pending
          })
        },
      )
      .post(
        '/conversations/:id/confirm',
        valid('param', z.object({ id: Id })),
        valid('json', z.object({ toolId: z.string().min(1).max(200) })),
        async (c) => {
          const { id } = c.req.valid('param')
          const outcome = await assistant.confirm(
            c.get('principal'),
            id,
            c.req.valid('json').toolId,
          )
          return c.json(outcome, outcome.isError ? 422 : 200)
        },
      )
      .post('/undo/:id', valid('param', z.object({ id: Id })), async (c) => {
        return c.json(await assistant.undo(c.get('principal'), c.req.valid('param').id))
      })
      /** Admins: this month's (or `month`'s) usage per member. */
      .get(
        '/usage',
        valid(
          'query',
          z.object({
            month: z
              .string()
              .regex(/^\d{4}-\d{2}$/)
              .optional(),
          }),
        ),
        (c) => {
          adminOnly(c.get('principal'), 'see assistant usage')
          const month = c.req.valid('query').month ?? monthOf(new Date())
          return c.json({ month, members: assistant.store.usage(month) })
        },
      )
      // Model and monthly limit (R12): live at once, admins only, and the environment wins.
      .get('/settings', (c) => {
        adminOnly(c.get('principal'), 'see the assistant settings')
        return c.json(settingsView())
      })
      .put(
        '/settings',
        valid(
          'json',
          z.object({
            model: z.enum(ASSISTANT_MODELS.map((m) => m.id) as [string, ...string[]]).optional(),
            monthlyLimitUsd: z.number().min(0).max(100_000).optional(),
          }),
        ),
        (c) => {
          adminOnly(c.get('principal'), 'change the assistant settings')
          const { model, monthlyLimitUsd } = c.req.valid('json')
          org.saveSettings({ assistantModel: model, assistantMonthlyLimitUsd: monthlyLimitUsd })
          return c.json(settingsView())
        },
      )
  )
}
