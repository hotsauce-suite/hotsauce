import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { HotsauceError } from '../errors.js'

// Who each member is, whatever id the sign-in provider gives them (docs/PLAN-sign-in-identity.md).
//
// Everything a member owns is keyed by `Principal.userId`. That used to be the provider's own id,
// which changes when the organization moves to another sign-in instance (development to
// production) or an account is deleted and made again. So the member id is now ours: the first
// provider id a person was seen with, kept for good. Later provider ids for the same verified
// email are linked to it here, and nothing the member owns has to be rewritten.

const Link = z.object({
  /** The member this provider id belongs to. */
  member: z.string(),
  /** Which sign-in instance issued the id (a fingerprint, see `instanceOf`). */
  instance: z.string(),
  email: z.string(),
  linkedAt: z.string(),
})
type Link = z.infer<typeof Link>

const State = z.object({
  /** Provider id → its link. */
  ids: z.record(z.string(), Link).default({}),
  /** Instances whose existing accounts were all recorded, and when. */
  listed: z.record(z.string(), z.string()).default({}),
})
type State = z.infer<typeof State>

/**
 * Names a sign-in instance without keeping anything usable from its key: the start of a hash of
 * the secret key, which is long and random.
 */
export function instanceOf(secretKey: string): string {
  return createHash('sha256').update(`hotsauce-sign-in:${secretKey}`).digest('hex').slice(0, 12)
}

/**
 * The record of provider ids and the members they belong to. It can't be rebuilt from anything
 * else, so it lives on the volume at `DATA_DIR/identities/identities.json` and is backed up with
 * the rest. Without a data directory (tests) it is kept in memory.
 */
export class IdentityLedger {
  readonly #file: string | null
  readonly #log: (message: string) => void
  #state: State

  constructor(opts: { dataDir?: string; log?: (message: string) => void } = {}) {
    this.#file = opts.dataDir ? path.join(opts.dataDir, 'identities', 'identities.json') : null
    this.#log = opts.log ?? console.log
    this.#state = this.#read()
  }

  /**
   * The member behind a provider id, linking the id when it is new. A new id whose email already
   * belongs to a member becomes that member, but only when the provider verified the email;
   * otherwise it is refused, so nobody takes over a member by typing their address.
   */
  resolve(
    authId: string,
    who: { email: string; verified: boolean; instance: string },
    now: Date = new Date(),
  ): string {
    const email = who.email.toLowerCase()
    const known = this.#state.ids[authId]
    if (known) {
      if (known.email !== email) {
        this.#write({
          ...this.#state,
          ids: { ...this.#state.ids, [authId]: { ...known, email } },
        })
      }
      return known.member
    }
    const member = this.#memberWithEmail(email)
    if (member !== null && !who.verified) {
      throw new HotsauceError(
        'unauthorized',
        `${email} isn't verified yet. Sign in with Google, or with the code emailed to you.`,
      )
    }
    const link: Link = {
      member: member ?? authId,
      instance: who.instance,
      email,
      linkedAt: now.toISOString(),
    }
    this.#write({ ...this.#state, ids: { ...this.#state.ids, [authId]: link } })
    if (member !== null) {
      this.#log(`sign-in: ${email} has a new account id; kept as the same member`)
    }
    return link.member
  }

  /** The member's newest provider id in this instance, or null when they have none there. */
  authIdFor(member: string, instance: string): string | null {
    let best: { id: string; at: string } | null = null
    for (const [id, link] of Object.entries(this.#state.ids)) {
      if (link.member !== member || link.instance !== instance) continue
      if (!best || link.linkedAt > best.at) best = { id, at: link.linkedAt }
    }
    return best?.id ?? null
  }

  /** The member's email as last seen, or null for a member this record doesn't know. */
  emailOf(member: string): string | null {
    let best: Link | null = null
    for (const link of Object.values(this.#state.ids)) {
      if (link.member !== member) continue
      if (!best || link.linkedAt > best.linkedAt) best = link
    }
    return best?.email ?? null
  }

  /** How many members are recorded (logged at startup, so a move can be checked first). */
  memberCount(): number {
    return new Set(Object.values(this.#state.ids).map((l) => l.member)).size
  }

  /** How many members have an id in this instance. */
  memberCountIn(instance: string): number {
    return new Set(
      Object.values(this.#state.ids)
        .filter((l) => l.instance === instance)
        .map((l) => l.member),
    ).size
  }

  wasListed(instance: string): boolean {
    return this.#state.listed[instance] !== undefined
  }

  markListed(instance: string, now: Date = new Date()): void {
    this.#write({
      ...this.#state,
      listed: { ...this.#state.listed, [instance]: now.toISOString() },
    })
  }

  /** The member whose newest link carries this email, or null. */
  #memberWithEmail(email: string): string | null {
    let best: Link | null = null
    for (const link of Object.values(this.#state.ids)) {
      if (link.email !== email) continue
      if (!best || link.linkedAt > best.linkedAt) best = link
    }
    return best?.member ?? null
  }

  #read(): State {
    if (!this.#file) return { ids: {}, listed: {} }
    let text: string
    try {
      text = readFileSync(this.#file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ids: {}, listed: {} }
      throw err
    }
    try {
      return State.parse(JSON.parse(text))
    } catch (err) {
      // Starting empty would hand every member a fresh id the next time theirs changes.
      throw new Error(`${this.#file} is unreadable: ${err}`)
    }
  }

  #write(next: State): void {
    if (this.#file) {
      mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 })
      writeFileSync(`${this.#file}.tmp`, JSON.stringify(next), { mode: 0o600 })
      renameSync(`${this.#file}.tmp`, this.#file)
    }
    this.#state = next
  }
}
