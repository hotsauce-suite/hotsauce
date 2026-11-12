import { HearthError } from '../errors.js'

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
/** The token the dev and test robot check accepts. */
export const DEV_TURNSTILE_TOKEN = 'dev-pass'

/** Checks a booker's Cloudflare Turnstile token (ARCHITECTURE §19.3). */
export interface RobotCheck {
  /** What the booking page shows: Cloudflare's widget with this site key, or the dev stand-in. */
  readonly widget: { kind: 'turnstile'; siteKey: string } | { kind: 'dev' }
  verify(token: string, ip: string | null): Promise<boolean>
}

/** Cloudflare's siteverify, with the secret from the host's secret store. */
export class Turnstile implements RobotCheck {
  readonly widget: { kind: 'turnstile'; siteKey: string }
  readonly #secret: string
  readonly #fetch: typeof fetch

  constructor(opts: { siteKey: string; secret: string; fetch?: typeof fetch }) {
    this.widget = { kind: 'turnstile', siteKey: opts.siteKey }
    this.#secret = opts.secret
    this.#fetch = opts.fetch ?? fetch
  }

  async verify(token: string, ip: string | null): Promise<boolean> {
    if (!token || token.length > 2048) return false
    const form = new URLSearchParams({ secret: this.#secret, response: token })
    if (ip) form.set('remoteip', ip)
    let res: Response
    try {
      res = await this.#fetch(SITEVERIFY, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(10_000),
      })
    } catch (err) {
      throw new HearthError('host_error', `Couldn't reach Cloudflare Turnstile (${err})`)
    }
    if (!res.ok) {
      await res.body?.cancel()
      throw new HearthError('host_error', `Cloudflare Turnstile answered ${res.status}`)
    }
    const body = (await res.json()) as { success?: unknown }
    return body.success === true
  }
}

/** Dev and test only (never production): passes the token `dev-pass`. */
export class FakeRobotCheck implements RobotCheck {
  readonly widget = { kind: 'dev' as const }
  async verify(token: string): Promise<boolean> {
    return token === DEV_TURNSTILE_TOKEN
  }
}
