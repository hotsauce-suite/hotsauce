import { createHash } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { HotsauceError } from '../errors.js'

// Who each member is, whatever id the sign-in provider gives them (docs/PLAN-sign-in-identity.md).
//
// Everything a member owns is keyed by `Principal.userId`. That used to be the provider's own id,
// which changes when the organization moves to another sign-in instance (development to
// production). So the member id is now ours: the first provider id a person was seen with, kept
// for good. An id from another instance with the same verified email is linked to it here, and
// nothing the member owns has to be rewritten.

const Link = z.object({
  /** The member this provider id belongs to. */
  member: z.string(),
  /** Which sign-in instance issued the id (a fingerprint, see `instanceOf`). */
  instance: z.string(),
  email: z.string(),
  /** Whether the provider had verified that email. Only verified links are matched by email. */
  verified: z.boolean().default(false),
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
   * The member behind a provider id, linking the id when it is new.
   *
   * A new id becomes an existing member only when all of this holds: the provider verified its
   * email, a verified link of that member carries the same email, and the member has no id in
   * this instance yet. So a move to another instance keeps everyone, while an account deleted
   * and made again in the same instance starts fresh, as it always has (its old tokens and
   * devices stay dead). A new id whose unverified email is a member's is refused.
   */
  resolve(
    authId: string,
    who: { email: string; verified: boolean; instance: string },
    now: Date = new Date(),
  ): string {
    const email = who.email.toLowerCase()
    const known = this.#state.ids[authId]
    if (known) {
      const ids = { ...this.#state.ids }
      let changed = false
      // The same account under a rotated key: it is in this instance now.
      if (known.instance !== who.instance) {
        ids[authId] = { ...known, instance: who.instance }
        changed = true
      }
      // A verified change of address moves the whole member, so the address they left can't
      // be used to become them.
      if (who.verified && (known.email !== email || !known.verified)) {
        for (const [id, link] of Object.entries(ids)) {
          if (link.member === known.member) ids[id] = { ...link, email, verified: true }
        }
        changed = true
      }
      if (changed) this.#write({ ...this.#state, ids })
      return known.member
    }
    const candidate = matchable(who.email) ? this.#memberWithEmail(email) : null
    const member =
      candidate !== null && this.authIdFor(candidate, who.instance) === null ? candidate : null
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
      verified: who.verified,
      linkedAt: now.toISOString(),
    }
    this.#write({ ...this.#state, ids: { ...this.#state.ids, [authId]: link } })
    if (member !== null) {
      this.#log(`sign-in: ${email} has a new account id; kept as the same member`)
    } else if (Object.values(this.#state.listed).length > 0 && !this.wasListed(who.instance)) {
      // Worth a look after a move: someone the record should have known, if it was complete.
      this.#log(`sign-in: ${email} is new to the record and starts as a new member`)
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

  /** The member whose newest verified link carries this email, or null. */
  #memberWithEmail(email: string): string | null {
    let best: Link | null = null
    for (const link of Object.values(this.#state.ids)) {
      if (link.email !== email || !link.verified) continue
      // On a tie the later link wins: links are kept in the order they were made.
      if (!best || link.linkedAt >= best.linkedAt) best = link
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
      // Flushed before it replaces the old file: a crash must not leave an empty record.
      const fd = openSync(`${this.#file}.tmp`, 'w', 0o600)
      try {
        writeSync(fd, JSON.stringify(next))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(`${this.#file}.tmp`, this.#file)
    }
    this.#state = next
  }
}

/** ASCII only: lowercasing some Unicode letters (the Kelvin sign) yields ASCII look-alikes. */
function matchable(email: string): boolean {
  return email.includes('@') && !/[^\x20-\x7e]/.test(email)
}
