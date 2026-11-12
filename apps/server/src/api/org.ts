import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { createMiddleware } from 'hono/factory'
import { z } from 'zod'
import { CLOUDFLARE_MEDIA, CLOUDFLARE_REPOS, loadConfig } from '../config.js'
import { HearthError } from '../errors.js'
import { ASSET_TYPES, BrandPatchSchema, FONT_CHOICES, MAX_ASSET_BYTES } from '../org/brand.js'
import { type OrgSettings, SECRET_NAMES, type SecretName } from '../org/store.js'
import { testProvider } from '../org/test-keys.js'
import type { AppDeps, AppEnv } from './env.js'

/**
 * The organization: setup wizard, Settings → Organization, and the public brand kit
 * (ARCHITECTURE §11).
 *
 * - `/api/org/*` is public: the brand and its logo, which the sign-in page shows.
 * - `/api/setup/*` works only while the instance is in setup mode, and only with the one-time
 *   setup token (header `x-setup-token`), which the server prints in its log at startup.
 * - `/api/admin/org/*` is the same editor for an admin once the instance is running.
 */

export const SETUP_TOKEN_HEADER = 'x-setup-token'

const domainRe = /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const listOf = (re: RegExp, what: string) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((v) =>
      (Array.isArray(v) ? v : v.split(/[,\s]+/))
        .map((x) => x.trim().toLowerCase().replace(/^@/, ''))
        .filter(Boolean),
    )
    .refine((xs) => xs.every((x) => re.test(x)), `Every entry must be a valid ${what}`)
    .transform((xs) => [...new Set(xs)])

const SettingsPatch = z
  .object({
    orgName: z.string().trim().max(80),
    productName: z.string().trim().max(40),
    allowedDomains: listOf(domainRe, 'domain, like example.com'),
    allowedEmails: listOf(emailRe, 'email address'),
    adminEmails: listOf(emailRe, 'email address'),
    clerkPublishableKey: z
      .string()
      .trim()
      .refine((k) => k === '' || /^pk_(test|live)_[A-Za-z0-9+/=_-]+$/.test(k), {
        message: 'A Clerk publishable key starts with pk_test_ or pk_live_',
      }),
    hostKind: z.enum(['local', 'github']),
    githubOrg: z
      .string()
      .trim()
      .refine((s) => s === '' || /^[A-Za-z0-9-]{1,39}$/.test(s), 'Not a GitHub organization name'),
    r2AccountId: z.string().trim(),
    r2AccessKeyId: z.string().trim(),
    r2Bucket: z.string().trim(),
    keepAudio: z.boolean(),
    chatUrl: z
      .string()
      .trim()
      .refine((u) => u === '' || /^https:\/\/[^\s]+$/.test(u), 'Use a full https:// link'),
    stepsDone: z.array(z.string().max(40)).max(20),
    /** Marks one wizard step done, added to the saved list (so two quick steps can't race). */
    addStepDone: z.string().max(40),
    /** Secrets to save; an empty string removes one. Never echoed back. */
    secrets: z.partialRecord(z.enum(SECRET_NAMES), z.string().max(4000)),
  })
  .partial()
  .strict()

const TestBody = z.object({ key: z.string().max(4000).optional(), extra: z.string().optional() })

/** The editor's view: settings, which secrets are set (last four characters only), env overrides. */
function stateOf(deps: AppDeps) {
  const { org, brand, config } = deps
  const settings = org.settings()
  const secrets = Object.fromEntries(SECRET_NAMES.map((n) => [n, org.secretStatus(n)])) as Record<
    SecretName,
    ReturnType<typeof org.secretStatus>
  >
  const env = deps.org.env
  return {
    settings,
    secrets,
    // 'cloudflare': the disk is temporary, so the wizard offers only GitHub and R2.
    platform: config.HOTSAUCE_PLATFORM,
    // Settings the environment sets win over the saved ones; the editor shows them as locked.
    lockedByEnv: {
      orgName: Boolean(env.ORG_NAME),
      productName: Boolean(env.PRODUCT_NAME),
      allowedDomains: Boolean(env.ALLOWED_EMAIL_DOMAINS),
      allowedEmails: Boolean(env.ALLOWED_EMAILS),
      adminEmails: Boolean(env.ADMIN_EMAILS),
      clerkPublishableKey: Boolean(env.CLERK_PUBLISHABLE_KEY),
      hostKind: Boolean(env.HOST_KIND),
      chatUrl: Boolean(env.CHAT_URL),
      githubOrg: Boolean(env.GITHUB_ORG),
      r2AccountId: Boolean(env.R2_ACCOUNT_ID),
      r2AccessKeyId: Boolean(env.R2_ACCESS_KEY_ID),
      r2Bucket: Boolean(env.R2_BUCKET),
      keepAudio: Boolean(env.KEEP_AUDIO),
    },
    effective: {
      orgName: config.ORG_NAME,
      productName: config.PRODUCT_NAME,
      allowedDomains: config.ALLOWED_EMAIL_DOMAINS,
      allowedEmails: config.ALLOWED_EMAILS,
      adminEmails: config.ADMIN_EMAILS,
      hostKind: config.HOST_KIND,
      ai: config.LLM_PROVIDER !== 'none',
      transcription: config.ASR_PROVIDER !== 'none',
      publicUrl: config.PUBLIC_URL,
    },
    brand: brand.get(),
    fontChoices: FONT_CHOICES,
    setupMode: config.AUTH_MODE === 'setup',
    // What finishing still needs (empty when ready).
    missing: missingForFinish(deps),
  }
}

function saveSettings(deps: AppDeps, body: unknown): OrgSettings {
  const parsed = SettingsPatch.safeParse(body)
  if (!parsed.success) {
    throw new HearthError('bad_request', parsed.error.issues[0]?.message ?? 'Invalid settings', {
      details: parsed.error.issues,
    })
  }
  const { secrets, addStepDone, ...rest } = parsed.data
  if (addStepDone) {
    const done = rest.stepsDone ?? deps.org.settings().stepsDone
    rest.stepsDone = done.includes(addStepDone) ? done : [...done, addStepDone].slice(-20)
  }
  for (const [name, value] of Object.entries(secrets ?? {})) {
    deps.org.saveSecret(name as SecretName, value)
  }
  return deps.org.saveSettings(rest)
}

/** What finishing needs; each missing item is one line the wizard can show. */
export function missingForFinish(deps: AppDeps): string[] {
  const s = deps.org.settings()
  const env = deps.org.env
  const missing: string[] = []
  if (!(s.orgName || env.ORG_NAME)) missing.push('Your organization’s name')
  if (!(s.allowedDomains.length || env.ALLOWED_EMAIL_DOMAINS)) {
    missing.push('At least one email domain that may sign in')
  }
  if (!(s.adminEmails.length || env.ADMIN_EMAILS)) missing.push('At least one admin email')
  if (!(s.clerkPublishableKey || env.CLERK_PUBLISHABLE_KEY)) missing.push('Clerk publishable key')
  if (!deps.org.effectiveSecret('CLERK_SECRET_KEY')) missing.push('Clerk secret key')
  if (s.hostKind === 'github' && !(s.githubOrg && deps.org.effectiveSecret('GITHUB_TOKEN'))) {
    missing.push('GitHub organization and token (or choose “On this server”)')
  }
  const r2 = partialR2(deps)
  if (r2) missing.push(r2)
  if ((env.HOTSAUCE_PLATFORM ?? '') === 'cloudflare') {
    if ((env.HOST_KIND ?? s.hostKind) === 'local') missing.push(CLOUDFLARE_REPOS)
    const r2Set = Boolean(env.R2_BUCKET || (s.r2AccountId && s.r2AccessKeyId && s.r2Bucket))
    if (!r2Set && env.AUDIO_STORE !== 'none') missing.push(CLOUDFLARE_MEDIA)
  }
  // Every admin must be able to sign in. The environment's lists win, as they will at startup.
  const list = (v: string | undefined) =>
    (v ?? '')
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean)
  const domains = env.ALLOWED_EMAIL_DOMAINS ? list(env.ALLOWED_EMAIL_DOMAINS) : s.allowedDomains
  const admins = env.ADMIN_EMAILS ? list(env.ADMIN_EMAILS) : s.adminEmails
  const invited = env.ALLOWED_EMAILS ? list(env.ALLOWED_EMAILS) : s.allowedEmails
  for (const email of admins) {
    if (!domains.includes(email.split('@')[1] ?? '') && !invited.includes(email)) {
      missing.push(`${email} isn’t in an allowed domain, so it couldn’t sign in`)
    }
  }
  return missing
}

/**
 * The configuration the server would start with after a restart, checked before restarting: a
 * restart into a config that doesn't load would leave the instance down until someone edits the
 * volume by hand. Returns the problems, empty when it would start.
 */
/** Some R2 values but not all four: without the rest, video would quietly go to the disk. */
function partialR2(deps: AppDeps): string | null {
  const s = deps.org.settings()
  const r2 = [s.r2AccountId, s.r2AccessKeyId, s.r2Bucket].filter(Boolean).length
  if (r2 > 0 && (r2 < 3 || !deps.org.effectiveSecret('R2_SECRET_ACCESS_KEY'))) {
    return 'All four Cloudflare R2 values (or clear them to keep videos and audio on this server’s disk)'
  }
  return null
}

export function nextConfigProblems(deps: AppDeps): string[] {
  const r2 = partialR2(deps)
  if (r2) return [r2]
  try {
    loadConfig({
      ...deps.org.toEnv({ asIfComplete: true }),
      HOTSAUCE_SETUP_PENDING: 'false',
      ...deps.org.env,
    })
    return []
  } catch (err) {
    return (err as Error).message
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean)
  }
}

/** GitHub-hosted spaces need a webhook secret; make one the first time it's needed. */
function ensureWebhookSecret(deps: AppDeps): void {
  const s = deps.org.settings()
  if (s.hostKind === 'github' && !deps.org.effectiveSecret('WEBHOOK_SECRET')) {
    deps.org.saveSecret('WEBHOOK_SECRET', randomBytes(32).toString('base64url'))
  }
}

function editorRoutes(deps: AppDeps, opts: { onSaved: () => void; validate: boolean }) {
  return new Hono<AppEnv>()
    .get('/state', (c) => c.json(stateOf(deps)))
    .put('/settings', async (c) => {
      const body = await c.req.json().catch(() => ({}))
      // On a running instance saved settings apply at the next restart, whatever causes it (a
      // deploy, a crash), so a save that the server couldn't start with is undone at once.
      const before = opts.validate ? deps.org.snapshot() : null
      saveSettings(deps, body)
      opts.onSaved()
      if (before) {
        ensureWebhookSecret(deps)
        const problems = nextConfigProblems(deps)
        if (problems.length > 0) {
          deps.org.restore(before)
          throw new HearthError(
            'bad_request',
            `Not saved: the server wouldn’t start with this: ${problems.join('; ')}`,
            {
              details: { problems },
            },
          )
        }
      }
      return c.json(stateOf(deps))
    })
    .put('/brand', async (c) => {
      const parsed = BrandPatchSchema.safeParse(await c.req.json().catch(() => ({})))
      if (!parsed.success) {
        throw new HearthError('bad_request', parsed.error.issues[0]?.message ?? 'Invalid brand')
      }
      deps.brand.save(parsed.data)
      return c.json(stateOf(deps))
    })
    .put(
      '/assets/:kind{logo|mark}',
      bodyLimit({
        maxSize: MAX_ASSET_BYTES,
        onError: () => {
          throw new HearthError('bad_request', 'Logos are limited to 1 MB', { status: 413 })
        },
      }),
      async (c) => {
        const kind = c.req.param('kind') as 'logo' | 'mark'
        const type = (c.req.header('content-type') ?? '').split(';')[0]?.trim() ?? ''
        const ext = ASSET_TYPES[type]
        if (!ext) throw new HearthError('bad_request', 'Use an SVG, PNG, JPEG or WebP image')
        const bytes = new Uint8Array(await c.req.arrayBuffer())
        if (bytes.length === 0) throw new HearthError('bad_request', 'The file is empty')
        const name = `${kind}.${ext}`
        for (const other of Object.values(ASSET_TYPES)) {
          if (other !== ext) rmSync(deps.org.assetPath(`${kind}.${other}`), { force: true })
        }
        writeFileSync(deps.org.assetPath(name), bytes, { mode: 0o600 })
        deps.brand.save({ [kind]: name })
        return c.json(stateOf(deps))
      },
    )
    .delete('/assets/:kind{logo|mark}', (c) => {
      const kind = c.req.param('kind') as 'logo' | 'mark'
      const current = deps.brand.get()[kind]
      if (current) rmSync(deps.org.assetPath(current), { force: true })
      deps.brand.save({ [kind]: null })
      return c.json(stateOf(deps))
    })
    .post('/test/:provider{anthropic|deepgram|clerk|github}', async (c) => {
      const provider = c.req.param('provider') as 'anthropic' | 'deepgram' | 'clerk' | 'github'
      const body = TestBody.parse(await c.req.json().catch(() => ({})))
      const saved: Record<typeof provider, SecretName> = {
        anthropic: 'ANTHROPIC_API_KEY',
        deepgram: 'DEEPGRAM_API_KEY',
        clerk: 'CLERK_SECRET_KEY',
        github: 'GITHUB_TOKEN',
      }
      const key = body.key?.trim() || deps.org.effectiveSecret(saved[provider]) || ''
      const extra =
        body.extra ??
        (provider === 'github'
          ? deps.org.settings().githubOrg
          : deps.org.settings().clerkPublishableKey)
      return c.json(await testProvider(provider, key, extra ?? ''))
    })
}

/** The setup wizard's guard: setup mode, plus the one-time token. */
function requireSetup(deps: AppDeps) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (deps.config.AUTH_MODE !== 'setup') {
      throw new HearthError('forbidden', 'This instance is already set up. Sign in instead.')
    }
    if (!deps.org.checkSetupToken(c.req.header(SETUP_TOKEN_HEADER))) {
      throw new HearthError(
        'unauthorized',
        'That setup link isn’t valid. Use the link printed in the server log when it started.',
      )
    }
    await next()
  })
}

function requireAdmin() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const p = c.get('principal')
    if (!p?.isAdmin) throw new HearthError('forbidden', 'Only admins can change the organization')
    if (p.via) throw new HearthError('forbidden', 'Access tokens can’t change the organization')
    await next()
  })
}

/** Public: the brand kit and its logo. Reachable before sign-in (see `isPublic`). */
export function orgPublicRoutes(deps: AppDeps) {
  return new Hono<AppEnv>()
    .get('/org/brand', (c) => {
      c.header('Cache-Control', 'no-cache')
      return c.json(deps.brand.publicView(deps.config.PRODUCT_NAME, deps.config.ORG_NAME))
    })
    .get('/org/assets/:kind{logo|mark}', (c) => {
      const name = deps.brand.get()[c.req.param('kind') as 'logo' | 'mark']
      const file = name ? deps.org.assetPath(name) : null
      if (!file || !existsSync(file)) throw new HearthError('not_found', 'No such image')
      const ext = name?.split('.').pop() ?? ''
      const type =
        Object.entries(ASSET_TYPES).find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream'
      c.header('Content-Type', type)
      c.header('X-Content-Type-Options', 'nosniff')
      // An SVG can carry script; served like this it can't run any.
      c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      c.header('Cache-Control', 'public, max-age=300')
      return c.body(readFileSync(file))
    })
}

export function setupRoutes(deps: AppDeps) {
  const restartSoon = () => setTimeout(() => deps.restart?.(), 400)
  return new Hono<AppEnv>()
    .use('/setup/*', requireSetup(deps))
    .route('/setup', editorRoutes(deps, { onSaved: () => {}, validate: false }))
    .post('/setup/finish', (c) => {
      const missing = missingForFinish(deps)
      if (missing.length > 0) {
        throw new HearthError('bad_request', `Still needed: ${missing.join('; ')}`, {
          details: { missing },
        })
      }
      ensureWebhookSecret(deps)
      const problems = nextConfigProblems(deps)
      if (problems.length > 0) {
        throw new HearthError(
          'bad_request',
          `The server wouldn’t start with these settings: ${problems.join('; ')}`,
          {
            details: { problems },
          },
        )
      }
      const s = deps.org.settings()
      deps.org.saveSettings({
        setupComplete: true,
        completedAt: new Date().toISOString(),
        productName: s.productName || 'Hotsauce',
      })
      deps.org.clearSetupToken()
      // The new settings take effect on restart; the process manager starts us again.
      restartSoon()
      return c.json({ ok: true as const, restarting: true })
    })
}

export function adminOrgRoutes(deps: AppDeps) {
  return new Hono<AppEnv>()
    .use('/admin/org/*', requireAdmin())
    .route(
      '/admin/org',
      editorRoutes(deps, {
        validate: true,
        // An instance configured by env (set up before the wizard existed) becomes wizard-managed
        // the first time an admin saves here. Env values still win.
        onSaved: () => {
          if (!deps.org.settings().setupComplete) {
            deps.org.saveSettings({ setupComplete: true, completedAt: new Date().toISOString() })
          }
        },
      }),
    )
    .post('/admin/org/apply', (c) => {
      ensureWebhookSecret(deps)
      const problems = nextConfigProblems(deps)
      if (problems.length > 0) {
        throw new HearthError(
          'bad_request',
          `Not applied: the server wouldn’t start with these settings: ${problems.join('; ')}`,
          {
            details: { problems },
          },
        )
      }
      setTimeout(() => deps.restart?.(), 400)
      return c.json({ ok: true as const, restarting: true })
    })
}
