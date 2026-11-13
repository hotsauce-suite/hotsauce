import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { createMiddleware } from 'hono/factory'
import { backupHealth } from '../backup/index.js'
import { HearthError } from '../errors.js'
import { readVersion } from '../updates/version.js'
import type { AppDeps, AppEnv } from './env.js'

const MAX_WEBHOOK_BYTES = 5 * 1024 * 1024
// Every delivery from a host is signed: GitHub in the first, Forgejo in the second.
const SIGNATURE_HEADERS = ['x-hub-signature-256', 'x-forgejo-signature']

// Anyone can reach the webhook, so an unsigned request is turned away before a byte of it is read.
const requireSignature = createMiddleware<AppEnv>(async (c, next) => {
  if (!SIGNATURE_HEADERS.some((name) => c.req.header(name))) {
    throw new HearthError('unauthorized', 'Webhook requests must be signed')
  }
  await next()
})

const limitWebhookBody = bodyLimit({
  maxSize: MAX_WEBHOOK_BYTES,
  onError: () => {
    throw new HearthError('bad_request', 'Webhook payload is too large', { status: 413 })
  },
})

/** Routes reachable without a session (see `isPublic` in middleware.ts). */
export function publicRoutes(deps: AppDeps) {
  const { config, host, index, syncer } = deps
  const version = readVersion()
  return (
    new Hono<AppEnv>()
      .get('/health', (c) =>
        c.json({
          ok: true as const,
          // The Hotsauce release running here; the updater checks it after a deploy.
          version,
          authMode: config.AUTH_MODE,
          // What the web app needs before sign-in: who this is for, and how to sign in.
          setupRequired: config.AUTH_MODE === 'setup',
          productName: config.PRODUCT_NAME,
          orgName: config.ORG_NAME,
          clerkPublishableKey: config.CLERK_PUBLISHABLE_KEY ?? null,
          chatUrl: config.CHAT_URL ?? null,
          // For the sign-in page's hint ("Sign in with your example.com account").
          signInDomain: config.ALLOWED_EMAIL_DOMAINS[0] ?? null,
          // Invited people sign in with an emailed code; whether to offer it, never who they are.
          emailCodeSignIn: config.ALLOWED_EMAILS.length > 0,
          features: {
            ai: config.LLM_PROVIDER !== 'none',
            transcription: config.ASR_PROVIDER !== 'none',
          },
        }),
      )
      // For an uptime monitor (Better Stack, UptimeRobot...): 503 when the newest backup failed or
      // none has worked for 26 hours, so a broken backup alerts someone instead of failing quietly.
      .get('/health/backup', async (c) => {
        const health = deps.backups ? await deps.backups.health() : backupHealth(null, new Date())
        return c.json(health, health.ok ? 200 : 503)
      })
      .post('/webhooks/git', requireSignature, limitWebhookBody, async (c) => {
        const rawBody = await c.req.text()
        const headers = c.req.header()
        // Null is a bad signature, or an event that isn't a push; adapters don't tell them apart.
        const event = host.parseWebhook(headers, rawBody, config.WEBHOOK_SECRET)
        if (event === null) {
          throw new HearthError('unauthorized', 'Invalid webhook signature, or not a push event')
        }
        if (index.getSpace(event.repo) !== null) {
          try {
            await syncer.syncSpace(event.repo)
          } catch (err) {
            // The poller will pick the push up; the host needn't retry.
            console.error(`webhook sync of ${event.repo} failed:`, err)
          }
        }
        return c.body(null, 204)
      })
  )
}
