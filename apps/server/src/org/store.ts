import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

/**
 * The organization's own settings, chosen in the setup wizard or Settings → Organization rather
 * than in the environment (ARCHITECTURE §11). Kept on the volume beside the SQLite files:
 *
 *   <DATA_DIR>/org/settings.json   name, product name, sign-in domains, admins, storage choices
 *   <DATA_DIR>/org/secrets.json    provider keys, each sealed with AES-256-GCM
 *   <DATA_DIR>/org/brand.json      the brand kit (see brand.ts)
 *   <DATA_DIR>/org/assets/         logo and mark files
 *   <DATA_DIR>/org/setup-token     the one-time token that claims a fresh instance
 *
 * The environment always wins over anything here, so an instance configured with env vars (like
 * one deployed before the wizard existed) behaves exactly as before.
 */

export const SECRET_NAMES = [
  'CLERK_SECRET_KEY',
  'ANTHROPIC_API_KEY',
  'DEEPGRAM_API_KEY',
  'GITHUB_TOKEN',
  'R2_SECRET_ACCESS_KEY',
  'WEBHOOK_SECRET',
] as const
export type SecretName = (typeof SECRET_NAMES)[number]

export const OrgSettingsSchema = z.object({
  orgName: z.string().trim().max(80).default(''),
  productName: z.string().trim().max(40).default(''),
  allowedDomains: z.array(z.string()).default([]),
  adminEmails: z.array(z.string()).default([]),
  clerkPublishableKey: z.string().trim().default(''),
  hostKind: z.enum(['local', 'github']).default('local'),
  githubOrg: z.string().trim().default(''),
  r2AccountId: z.string().trim().default(''),
  r2AccessKeyId: z.string().trim().default(''),
  r2Bucket: z.string().trim().default(''),
  keepAudio: z.boolean().default(false),
  chatUrl: z.string().trim().default(''),
  /** Steps of the setup wizard the admin has been through, so it resumes where they left off. */
  stepsDone: z.array(z.string()).default([]),
  setupComplete: z.boolean().default(false),
  completedAt: z.string().optional(),
})
export type OrgSettings = z.infer<typeof OrgSettingsSchema>

const SealedSchema = z.object({ iv: z.string(), tag: z.string(), data: z.string() })
const SecretsFileSchema = z.record(z.string(), SealedSchema)

/** What the browser may see of a secret: whether it's set, and its last four characters. */
export interface SecretStatus {
  set: boolean
  last4: string | null
  /** 'env' when the environment sets it, which overrides (and hides) a saved value. */
  source: 'env' | 'saved' | null
}

export class OrgStore {
  readonly dir: string
  readonly #key: Buffer
  /** Keys tried after #key when opening a secret: the volume's master.key, if any. */
  readonly #fallbackKeys: Buffer[] = []
  readonly #env: Record<string, string | undefined>

  constructor(opts: {
    dataDir: string
    /** HOTSAUCE_MASTER_KEY: any string; hashed to a 256-bit key. Generated on the volume if unset. */
    masterKey?: string
    env?: Record<string, string | undefined>
  }) {
    this.dir = path.join(opts.dataDir, 'org')
    this.#env = opts.env ?? process.env
    mkdirSync(path.join(this.dir, 'assets'), { recursive: true })
    this.#key = createHash('sha256')
      .update(opts.masterKey || this.#generatedKey())
      .digest()
    // Secrets saved before HOTSAUCE_MASTER_KEY was set were sealed with the generated key; keep
    // opening them (new saves use the new key).
    const generated = path.join(this.dir, 'master.key')
    if (opts.masterKey && existsSync(generated)) {
      this.#fallbackKeys.push(
        createHash('sha256').update(readFileSync(generated, 'utf8').trim()).digest(),
      )
    }
  }

  // Without HOTSAUCE_MASTER_KEY the key lives on the volume next to what it seals. That still keeps
  // keys out of backups of settings.json and out of every API response; the deploy script sets one.
  #generatedKey(): string {
    const file = path.join(this.dir, 'master.key')
    if (!existsSync(file)) {
      writeAtomic(file, randomBytes(32).toString('base64'))
      console.warn('HOTSAUCE_MASTER_KEY is not set: generated one on the data volume')
    }
    return readFileSync(file, 'utf8').trim()
  }

  settings(): OrgSettings {
    const file = path.join(this.dir, 'settings.json')
    if (!existsSync(file)) return OrgSettingsSchema.parse({})
    try {
      return OrgSettingsSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
    } catch (err) {
      throw new Error(`${file} is not valid: ${(err as Error).message}`)
    }
  }

  saveSettings(patch: { [K in keyof OrgSettings]?: OrgSettings[K] | undefined }): OrgSettings {
    const next = OrgSettingsSchema.parse({ ...this.settings(), ...defined(patch) })
    writeAtomic(path.join(this.dir, 'settings.json'), `${JSON.stringify(next, null, 2)}\n`)
    return next
  }

  #secrets(): Record<string, z.infer<typeof SealedSchema>> {
    const file = path.join(this.dir, 'secrets.json')
    if (!existsSync(file)) return {}
    return SecretsFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
  }

  /** The saved value, decrypted. Not the environment's: see `effectiveSecret`. */
  savedSecret(name: SecretName): string | null {
    const sealed = this.#secrets()[name]
    if (!sealed) return null
    for (const key of [this.#key, ...this.#fallbackKeys]) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'))
        decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
        return Buffer.concat([
          decipher.update(Buffer.from(sealed.data, 'base64')),
          decipher.final(),
        ]).toString('utf8')
      } catch {
        // Try the next key.
      }
    }
    // The master key changed since it was saved; the admin has to enter it again.
    console.error(`org secret ${name} can't be decrypted with the current HOTSAUCE_MASTER_KEY`)
    return null
  }

  /** Saved secrets that no key can open: the master key changed since they were saved. */
  undecryptable(): SecretName[] {
    const saved = this.#secrets()
    return SECRET_NAMES.filter((n) => saved[n] && this.savedSecret(n) === null)
  }

  effectiveSecret(name: SecretName): string | null {
    return this.#env[name] || this.savedSecret(name)
  }

  /** Saves (or, with an empty value, deletes) a secret. */
  saveSecret(name: SecretName, value: string): void {
    const all = this.#secrets()
    const trimmed = value.trim()
    if (trimmed === '') delete all[name]
    else {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', this.#key, iv)
      const data = Buffer.concat([cipher.update(trimmed, 'utf8'), cipher.final()])
      all[name] = {
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
      }
    }
    writeAtomic(path.join(this.dir, 'secrets.json'), `${JSON.stringify(all, null, 2)}\n`)
  }

  secretStatus(name: SecretName): SecretStatus {
    const fromEnv = this.#env[name]
    const value = fromEnv || this.savedSecret(name)
    if (!value) return { set: false, last4: null, source: null }
    return { set: true, last4: value.slice(-4), source: fromEnv ? 'env' : 'saved' }
  }

  /**
   * Saved settings and secrets as environment variables, for `loadConfig`. The caller puts the real
   * environment on top, so env always wins. Empty values are left out.
   */
  toEnv(opts: { asIfComplete?: boolean } = {}): Record<string, string> {
    const s = this.settings()
    const out: Record<string, string> = {}
    // Until the wizard finishes, nothing saved takes effect: a half-entered sign-in key must not
    // end setup mode early. `asIfComplete` previews the config finishing would start with.
    if (!s.setupComplete && !opts.asIfComplete) return out
    const put = (k: string, v: string | null | undefined) => {
      if (v) out[k] = v
    }
    put('ORG_NAME', s.orgName)
    put('PRODUCT_NAME', s.productName)
    put('ALLOWED_EMAIL_DOMAINS', s.allowedDomains.join(','))
    put('ADMIN_EMAILS', s.adminEmails.join(','))
    put('CLERK_PUBLISHABLE_KEY', s.clerkPublishableKey)
    put('CHAT_URL', s.chatUrl)
    put('HOST_KIND', s.hostKind)
    if (s.hostKind === 'github') put('GITHUB_ORG', s.githubOrg)
    if (s.r2AccountId && s.r2AccessKeyId && s.r2Bucket) {
      put('R2_ACCOUNT_ID', s.r2AccountId)
      put('R2_ACCESS_KEY_ID', s.r2AccessKeyId)
      put('R2_BUCKET', s.r2Bucket)
    }
    if (s.keepAudio) put('KEEP_AUDIO', 'true')
    for (const name of SECRET_NAMES) put(name, this.savedSecret(name))
    return out
  }

  // --- The setup token -------------------------------------------------------------------------

  /** The token that claims this instance, created on first call. */
  setupToken(): string {
    const file = path.join(this.dir, 'setup-token')
    if (!existsSync(file)) writeAtomic(file, randomBytes(24).toString('base64url'))
    return readFileSync(file, 'utf8').trim()
  }

  /** The real environment this instance runs under, which always wins over saved settings. */
  get env(): Record<string, string | undefined> {
    return this.#env
  }

  /** The saved settings and secrets as they are on disk, to put back with `restore`. */
  snapshot(): Record<'settings.json' | 'secrets.json', string | null> {
    const read = (f: string) => {
      const file = path.join(this.dir, f)
      return existsSync(file) ? readFileSync(file, 'utf8') : null
    }
    return { 'settings.json': read('settings.json'), 'secrets.json': read('secrets.json') }
  }

  restore(snap: Record<'settings.json' | 'secrets.json', string | null>): void {
    for (const [f, content] of Object.entries(snap)) {
      const file = path.join(this.dir, f)
      if (content === null) rmSync(file, { force: true })
      else writeAtomic(file, content)
    }
  }

  /** Finishing setup spends the token; a later setup mode makes a new one. */
  clearSetupToken(): void {
    rmSync(path.join(this.dir, 'setup-token'), { force: true })
  }

  checkSetupToken(candidate: string | undefined | null): boolean {
    if (!candidate) return false
    const a = Buffer.from(this.setupToken())
    const b = Buffer.from(candidate.trim())
    return a.length === b.length && timingSafeEqual(a, b)
  }

  // --- Assets ----------------------------------------------------------------------------------

  assetPath(name: string): string {
    return path.join(this.dir, 'assets', path.basename(name))
  }
}

function writeAtomic(file: string, contents: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, contents, { mode: 0o600 })
  renameSync(tmp, file)
  chmodSync(file, 0o600)
}

export { writeAtomic }

/** Drops keys whose value is undefined, so a patch never resets a field to its default. */
function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}
