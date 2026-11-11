import path from 'node:path'
import { z } from 'zod'

const csv = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)

const DEV_WEBHOOK_SECRET = 'dev-webhook-secret'
const MIN_WEBHOOK_SECRET_LENGTH = 32

export const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    PUBLIC_URL: z.string().url().default('http://localhost:3000'),
    DATA_DIR: z.string().default('./.data'),

    // Who this instance is for (ARCHITECTURE §11). The setup wizard saves these; env wins.
    ORG_NAME: z.string().default(''),
    // The name people see everywhere in the app. An organization might set "Acme Office".
    PRODUCT_NAME: z.string().trim().min(1).default('Hotsauce'),
    // The organization's team chat, shown as a link in the app rail. Optional.
    CHAT_URL: z.string().url().optional(),
    // Seals provider keys saved through the wizard. Generated on the volume when unset.
    HOTSAUCE_MASTER_KEY: z.string().optional(),
    // Set by main.ts when the organization hasn't finished the setup wizard yet.
    HOTSAUCE_SETUP_PENDING: z
      .enum(['true', 'false', '1', '0'])
      .default('false')
      .transform((v) => v === 'true' || v === '1'),

    AUTH_MODE: z.enum(['clerk', 'dev']).default('clerk'),
    CLERK_SECRET_KEY: z.string().optional(),
    CLERK_PUBLISHABLE_KEY: z.string().optional(),
    ALLOWED_EMAIL_DOMAINS: z.string().default('').transform(csv),
    ADMIN_EMAILS: z.string().default('').transform(csv),

    HOST_KIND: z.enum(['local', 'forgejo', 'github']).default('local'),
    LOCAL_HOST_DIR: z.string().optional(),
    FORGEJO_URL: z.string().url().optional(),
    FORGEJO_TOKEN: z.string().optional(),
    FORGEJO_ORG: z.string().optional(),
    GITHUB_TOKEN: z.string().optional(),
    GITHUB_ORG: z.string().optional(),

    HEARTH_COMMITTER_NAME: z.string().optional(),
    HEARTH_COMMITTER_EMAIL: z.string().email().optional(),
    WEBHOOK_SECRET: z.string().default(DEV_WEBHOOK_SECRET),
    POLL_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
    IDLE_COMMIT_MS: z.coerce.number().int().positive().default(60_000),

    // Meetings (ARCHITECTURE §7.1). Providers default to the fakes in development and test, and
    // to the real ones in production, which refuses the fakes.
    ASR_PROVIDER: z.enum(['fake', 'deepgram', 'none']).optional(),
    DEEPGRAM_API_KEY: z.string().optional(),
    LLM_PROVIDER: z.enum(['fake', 'anthropic', 'none']).optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    ENHANCE_MODEL: z.string().min(1).default('claude-sonnet-5-5'),
    CHAT_MODEL: z.string().min(1).default('claude-opus-5-5'),
    // Hearth Dictate's cleanup pass runs on every dictation, so it uses a fast model.
    DICTATION_MODEL: z.string().min(1).default('claude-haiku-5-5'),
    // Hearth Clips (ARCHITECTURE §10): the title and summary model, and where ffmpeg is.
    CLIPS_MODEL: z.string().min(1).default('claude-haiku-5-5'),
    FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
    FFPROBE_PATH: z.string().min(1).default('ffprobe'),
    KEEP_AUDIO: z
      .enum(['true', 'false', '1', '0'])
      .default('false')
      .transform((v) => v === 'true' || v === '1'),
    // Where kept audio goes: Cloudflare R2, a folder on the volume (dev and test), or nowhere, in
    // which case "Keep audio" isn't offered. Defaults to r2 when its keys are set, else local in
    // development and test and none in production.
    AUDIO_STORE: z.enum(['none', 'local', 'r2']).optional(),
    R2_ACCOUNT_ID: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_BUCKET: z.string().optional(),
    // Web push for meeting reminders (PRD §6.1); reminders are off without both keys.
    // Generate a pair with `npx web-push generate-vapid-keys`.
    VAPID_PUBLIC_KEY: z.string().optional(),
    VAPID_PRIVATE_KEY: z.string().optional(),
    VAPID_SUBJECT: z.string().optional(),
    // Google Calendar sync (ARCHITECTURE §7.8): every member's calendar this often.
    CALENDAR_SYNC_MINUTES: z.coerce.number().positive().default(5),
    // Test only: `record` keeps reminder pushes in memory for e2e (GET /api/test/pushes).
    PUSH_SENDER: z.enum(['web', 'record']).default('web'),
    // A recording session with no socket for this long, or older than the maximum, is stopped
    // and saved by the server, so a tab that died doesn't record forever.
    SESSION_IDLE_STOP_MINUTES: z.coerce.number().int().positive().default(120),
    SESSION_MAX_HOURS: z.coerce.number().int().positive().default(8),
  })
  .transform((c) => {
    const production = c.NODE_ENV === 'production'
    // A fresh instance with no sign-in keys yet starts in setup mode: only the wizard works.
    const setup = c.AUTH_MODE === 'clerk' && !c.CLERK_SECRET_KEY && c.HOTSAUCE_SETUP_PENDING
    const publicHost = (() => {
      try {
        return new URL(c.PUBLIC_URL).hostname
      } catch {
        return 'localhost'
      }
    })()
    const committerEmail =
      c.HEARTH_COMMITTER_EMAIL ??
      `hotsauce@${publicHost.includes('.') ? publicHost : 'hotsauce.invalid'}`
    return {
      ...c,
      AUTH_MODE: setup ? ('setup' as const) : c.AUTH_MODE,
      // Development and test sign in as people at example.test unless told otherwise.
      ALLOWED_EMAIL_DOMAINS:
        c.ALLOWED_EMAIL_DOMAINS.length === 0 && !production
          ? ['example.test']
          : c.ALLOWED_EMAIL_DOMAINS,
      HEARTH_COMMITTER_NAME: c.HEARTH_COMMITTER_NAME ?? c.PRODUCT_NAME,
      HEARTH_COMMITTER_EMAIL: committerEmail,
      VAPID_SUBJECT: c.VAPID_SUBJECT ?? `mailto:${committerEmail}`,
      // In production a provider without a key is 'none': its features say "add a key" instead
      // of refusing to start, so an organization can bring its own keys later.
      ASR_PROVIDER:
        c.ASR_PROVIDER ?? (production ? (c.DEEPGRAM_API_KEY ? 'deepgram' : 'none') : 'fake'),
      LLM_PROVIDER:
        c.LLM_PROVIDER ?? (production ? (c.ANTHROPIC_API_KEY ? 'anthropic' : 'none') : 'fake'),
      AUDIO_STORE:
        c.AUDIO_STORE ??
        (c.R2_ACCOUNT_ID && c.R2_ACCESS_KEY_ID && c.R2_SECRET_ACCESS_KEY && c.R2_BUCKET
          ? ('r2' as const)
          : production
            ? ('none' as const)
            : ('local' as const)),
    }
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV === 'production' && c.ASR_PROVIDER === 'fake') {
      ctx.addIssue({
        code: 'custom',
        path: ['ASR_PROVIDER'],
        message: 'the fake transcriber is not allowed in production',
      })
    }
    if (c.NODE_ENV === 'production' && c.LLM_PROVIDER === 'fake') {
      ctx.addIssue({
        code: 'custom',
        path: ['LLM_PROVIDER'],
        message: 'the fake language model is not allowed in production',
      })
    }
    if (c.ASR_PROVIDER === 'deepgram' && !c.DEEPGRAM_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['DEEPGRAM_API_KEY'],
        message: 'DEEPGRAM_API_KEY is required when ASR_PROVIDER=deepgram',
      })
    }
    if (
      c.AUDIO_STORE === 'r2' &&
      !(c.R2_ACCOUNT_ID && c.R2_ACCESS_KEY_ID && c.R2_SECRET_ACCESS_KEY && c.R2_BUCKET)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUDIO_STORE'],
        message:
          'R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET are required when AUDIO_STORE=r2',
      })
    }
    if (Boolean(c.VAPID_PUBLIC_KEY) !== Boolean(c.VAPID_PRIVATE_KEY)) {
      ctx.addIssue({
        code: 'custom',
        path: ['VAPID_PRIVATE_KEY'],
        message: 'VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are set together, or not at all',
      })
    }
    if (c.KEEP_AUDIO && c.AUDIO_STORE === 'none') {
      ctx.addIssue({
        code: 'custom',
        path: ['KEEP_AUDIO'],
        message: 'KEEP_AUDIO=true needs somewhere to keep it: set AUDIO_STORE (r2 or local)',
      })
    }
    if (c.LLM_PROVIDER === 'anthropic' && !c.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['ANTHROPIC_API_KEY'],
        message: 'ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic',
      })
    }
  })
  .superRefine((c, ctx) => {
    // Fail closed: header-based dev auth is only ever allowed in development and test.
    if (c.PUSH_SENDER === 'record' && c.NODE_ENV !== 'test') {
      ctx.addIssue({
        code: 'custom',
        path: ['PUSH_SENDER'],
        message: 'PUSH_SENDER=record is only allowed when NODE_ENV is test',
      })
    }
    if (c.AUTH_MODE === 'dev' && c.NODE_ENV !== 'development' && c.NODE_ENV !== 'test') {
      ctx.addIssue({
        code: 'custom',
        message: 'AUTH_MODE=dev is only allowed when NODE_ENV is development or test',
      })
    }
    if (c.AUTH_MODE === 'clerk' && !c.CLERK_SECRET_KEY) {
      ctx.addIssue({ code: 'custom', message: 'CLERK_SECRET_KEY is required when AUTH_MODE=clerk' })
    }
    // Fail closed: with no domains nobody could sign in, and an empty list must never mean "anyone".
    if (
      c.AUTH_MODE !== 'setup' &&
      c.NODE_ENV === 'production' &&
      c.ALLOWED_EMAIL_DOMAINS.length === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['ALLOWED_EMAIL_DOMAINS'],
        message: 'ALLOWED_EMAIL_DOMAINS is required: the email domains that may sign in',
      })
    }
    if (c.HOST_KIND === 'forgejo' && !(c.FORGEJO_URL && c.FORGEJO_TOKEN && c.FORGEJO_ORG)) {
      ctx.addIssue({
        code: 'custom',
        message: 'FORGEJO_URL, FORGEJO_TOKEN and FORGEJO_ORG are required',
      })
    }
    if (c.HOST_KIND === 'github' && !(c.GITHUB_TOKEN && c.GITHUB_ORG)) {
      ctx.addIssue({ code: 'custom', message: 'GITHUB_TOKEN and GITHUB_ORG are required' })
    }
    // The secret is all that stops anyone from triggering syncs through the public webhook.
    if (
      c.NODE_ENV === 'production' &&
      c.HOST_KIND !== 'local' &&
      (c.WEBHOOK_SECRET === DEV_WEBHOOK_SECRET ||
        c.WEBHOOK_SECRET.length < MIN_WEBHOOK_SECRET_LENGTH)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['WEBHOOK_SECRET'],
        message: `WEBHOOK_SECRET must be set to a random value of at least ${MIN_WEBHOOK_SECRET_LENGTH} characters in production`,
      })
    }
  })
  .transform((c) => ({
    ...c,
    DATA_DIR: path.resolve(c.DATA_DIR),
    LOCAL_HOST_DIR: path.resolve(c.LOCAL_HOST_DIR ?? path.join(c.DATA_DIR, 'remotes')),
  }))

export type Config = z.infer<typeof ConfigSchema>

/** Parse config from an env-like object. Throws a readable error listing every problem. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = ConfigSchema.safeParse(env)
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  ${i.path.join('.') || '(config)'}: ${i.message}`,
    )
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`)
  }
  return result.data
}
