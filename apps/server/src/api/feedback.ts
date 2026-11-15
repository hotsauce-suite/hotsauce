import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { HotsauceError } from '../errors.js'
import { FEEDBACK_KINDS, MAX_SCREENSHOTS } from '../feedback/index.js'
import type { AppDeps, AppEnv } from './env.js'
import { sessionOnly } from './tokens.js'
import { valid } from './validate.js'

const Text = z.string().trim().min(1).max(5000)
const Answers = z
  .array(z.object({ question: z.string().max(500), answer: z.string().max(2000) }))
  .max(10)
  .default([])

const Submit = z.object({
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
})

/** The submit route, which alone takes pictures: three 5 MB screenshots plus the form around them. */
export const FEEDBACK_SUBMIT_PATH = '/api/feedback'
export const MAX_FEEDBACK_SUBMIT_BYTES = 16 * 1024 * 1024

const limitSubmit = bodyLimit({
  maxSize: MAX_FEEDBACK_SUBMIT_BYTES,
  onError: () => {
    throw new HotsauceError('bad_request', 'Screenshots are limited to three of 5 MB each', {
      status: 413,
    })
  },
})

/**
 * The submit body: JSON as always, or multipart with the same JSON in `payload` and up to three
 * `screenshot` files (docs/PLAN-feedback-screenshots.md S4). The service checks the pictures.
 */
async function readSubmit(
  req: Request,
): Promise<z.infer<typeof Submit> & { screenshots: Uint8Array[] }> {
  const multipart = (req.headers.get('content-type') ?? '').startsWith('multipart/form-data')
  let raw: unknown
  let files: File[] = []
  if (multipart) {
    let form: FormData
    try {
      form = await req.formData()
    } catch {
      throw new HotsauceError('bad_request', 'Send the feedback as multipart form data')
    }
    const payload = form.get('payload')
    if (typeof payload !== 'string') {
      throw new HotsauceError('bad_request', 'Send the feedback in the multipart field "payload"')
    }
    files = form.getAll('screenshot').filter((f): f is File => f instanceof File)
    if (files.length > MAX_SCREENSHOTS) {
      throw new HotsauceError('bad_request', `Attach at most ${MAX_SCREENSHOTS} screenshots`)
    }
    raw = parseJson(payload)
  } else {
    raw = parseJson(await req.text())
  }
  const parsed = Submit.safeParse(raw)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || 'json'}: ${i.message}`)
    throw new HotsauceError('bad_request', `Invalid json: ${problems.join('; ')}`)
  }
  const screenshots = await Promise.all(
    files.map(async (f) => new Uint8Array(await f.arrayBuffer())),
  )
  return { ...parsed.data, screenshots }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new HotsauceError('bad_request', 'Invalid json: the body is not JSON')
  }
}

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
    .post('/', limitSubmit, async (c) => {
      const principal = sessionOnly(c.get('principal'))
      // Before reading a body of up to 16 MB: feedback on, and this member under the hour's limit.
      service.assertCanFile(principal)
      return c.json(await service.submit(principal, await readSubmit(c.req.raw)), 201)
    })
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
