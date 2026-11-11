import { parseSpaceConfig, SPACE_LAYOUT } from '@hearth/format'
import type { Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import type { SpaceRecord } from '../index/index.js'

// Structural slices of GitStore (ARCHITECTURE §3.2) and HostAdapter (§3.3), copied exactly so the
// real classes satisfy them. Replace with imports from ../git and ../hosts once those land.
export interface Author {
  name: string
  email: string
}
export interface Change {
  path: string
  content: string | null
}
export interface Entry {
  path: string
  type: 'file' | 'dir'
  size?: number
  oid?: string
}
export type CommitResult =
  | { status: 'committed'; oid: string; blobOid: string }
  | { status: 'merged'; oid: string; blobOid: string; content: string }
  | {
      status: 'conflict'
      conflictRef: string
      theirs: { blobOid: string; content: string }
      ours: { content: string }
    }

export interface SpaceGit {
  ensureClone(space: string, remoteUrl: string): Promise<void>
  /** The clone's origin URL, or null when the space has no clone. */
  remoteUrl(space: string): Promise<string | null>
  listAll(space: string): Promise<Entry[]>
  /** Throws not_found for a missing file. */
  readFile(space: string, path: string): Promise<{ content: string }>
  commit(
    space: string,
    args: {
      changes: Change[]
      author: Author
      message: string
      base?: { path: string; blobOid: string }
    },
  ): Promise<CommitResult>
}

export interface SpaceHost {
  ensureRepo(name: string): Promise<{ cloneUrl: string }>
  ensureWebhook(name: string, url: string, secret: string): Promise<void>
  addCollaborator(name: string, username: string): Promise<void>
}

/** Who owns which space. The SQLite Index implements it. */
export interface SpaceRegistry {
  getSpace(name: string): SpaceRecord | null
  upsertSpace(space: Omit<SpaceRecord, 'createdAt'>): void
  listSpaces(): SpaceRecord[]
}

export interface Space {
  name: string
  kind: 'team' | 'personal'
  label: string
}

/** What a new space repo starts with; `owner` is the member's email for a personal space. */
export type InitialFiles = (
  name: string,
  opts: { kind: 'team' | 'personal'; owner?: string },
) => Array<{ path: string; content: string }>

export const TEAM_SPACE = 'team'

const SPACE_CONFIG = `${SPACE_LAYOUT.meta}/space.yaml`

const TEAM: Space = { name: TEAM_SPACE, kind: 'team', label: 'Team' }

function personalSpace(name: string): Space {
  return { name, kind: 'personal', label: 'Personal' }
}

// The stable identity under the domain lock. Clerk userIds change if a user is deleted and
// recreated, and handles collide (`a.b@` and `a-b@` are both `a-b`).
function ownerKey(p: Principal): string {
  return p.email.toLowerCase()
}

/** Minimal stand-in for tests; main.ts passes `initialSpaceFiles` from @hearth/format. */
export function defaultInitialFiles(name: string): Array<{ path: string; content: string }> {
  return [
    {
      path: 'README.md',
      content:
        `# ${name}\n\nA Hearth space. Documents live in \`docs/\`, meeting notes in \`meetings/\`, ` +
        'images in `assets/`. Hearth keeps its own metadata under `.hearth/`.\n',
    },
    { path: '.hearth/space.yaml', content: `name: ${JSON.stringify(name)}\nschema: 1\n` },
  ]
}

export class SpaceService {
  readonly #git: SpaceGit
  readonly #host: SpaceHost
  readonly #registry: SpaceRegistry
  readonly #committer: Author
  readonly #initialFiles: InitialFiles
  readonly #webhook: { url: string; secret: string } | undefined
  readonly #log: (message: string) => void
  // One provisioning per space per process; concurrent first requests share the same promise.
  readonly #ready = new Map<string, Promise<void>>()
  readonly #provisioned = new Set<string>()

  constructor(opts: {
    git: SpaceGit
    host: SpaceHost
    registry: SpaceRegistry
    committer: Author
    initialFiles?: InitialFiles
    /** Where the host should send push events (`POST /api/webhooks/git`); tests may leave it out. */
    webhook?: { url: string; secret: string }
    log?: (message: string) => void
  }) {
    this.#git = opts.git
    this.#host = opts.host
    this.#registry = opts.registry
    this.#committer = opts.committer
    this.#initialFiles = opts.initialFiles ?? defaultInitialFiles
    this.#webhook = opts.webhook
    this.#log = opts.log ?? console.warn
  }

  async ensureTeamSpace(): Promise<Space> {
    this.#registry.upsertSpace({ name: TEAM_SPACE, kind: 'team', ownerEmail: null })
    await this.#provision(TEAM_SPACE, this.#committer, { kind: 'team' })
    return TEAM
  }

  /**
   * Repo name is the member's handle; ownership is bound to their email. Called on their first
   * authenticated request. Throws `forbidden` if another member already holds the handle.
   */
  async ensurePersonalSpace(p: Principal): Promise<Space> {
    const name = p.handle
    const owner = ownerKey(p)
    if (name === '' || name === TEAM_SPACE) {
      throw new HearthError('forbidden', `${owner} can't have a personal space named "${name}"`)
    }
    // Check and claim with no await in between, so two members racing for one handle can't both win.
    const existing = this.#registry.getSpace(name)
    if (existing && existing.ownerEmail !== owner) {
      throw new HearthError('forbidden', 'handle already claimed by another member')
    }
    if (!existing) this.#registry.upsertSpace({ name, kind: 'personal', ownerEmail: owner })

    await this.#provision(name, { name: p.name, email: p.email }, { kind: 'personal', owner })
    return personalSpace(name)
  }

  /** The team space plus the personal space this member owns, once it is provisioned. */
  async visibleSpaces(p: Principal): Promise<Space[]> {
    const own = this.#ownedSpace(p)
    return own && this.#provisioned.has(own.name) ? [TEAM, personalSpace(own.name)] : [TEAM]
  }

  /** Team: every member. Personal: the recorded owner only; admins get no override. */
  canAccess(p: Principal, space: string): boolean {
    if (space === TEAM_SPACE) return true
    const record = this.#registry.getSpace(space)
    return record?.kind === 'personal' && record.ownerEmail === ownerKey(p)
  }

  /** Lets a member clone the team space and their own space directly (PRD §4.1). */
  async addCollaborator(p: Principal, hostUsername: string): Promise<void> {
    await this.#host.addCollaborator(TEAM_SPACE, hostUsername)
    const own = this.#ownedSpace(p)
    if (own) await this.#host.addCollaborator(own.name, hostUsername)
  }

  #ownedSpace(p: Principal): SpaceRecord | undefined {
    const owner = ownerKey(p)
    return this.#registry.listSpaces().find((s) => s.kind === 'personal' && s.ownerEmail === owner)
  }

  #provision(name: string, author: Author, opts: Parameters<InitialFiles>[1]): Promise<void> {
    let ready = this.#ready.get(name)
    if (!ready) {
      ready = this.#create(name, author, opts).then(() => {
        this.#provisioned.add(name)
      })
      // Forget failures so the next request retries.
      ready.catch(() => this.#ready.delete(name))
      this.#ready.set(name, ready)
    }
    return ready
  }

  async #create(name: string, author: Author, opts: Parameters<InitialFiles>[1]): Promise<void> {
    await this.#git.ensureClone(name, await this.#cloneUrl(name))
    if (opts.owner !== undefined) await this.#assertOwnerInGit(name, opts.owner)
    const existing = await this.#git.listAll(name)
    if (existing.length > 0) return
    await this.#git.commit(name, {
      changes: this.#initialFiles(name, opts),
      author,
      message: `hearth: create space "${name}"`,
    })
  }

  /**
   * Git is where ownership is recorded; the registry is a cache of it. If the repo's space.yaml
   * names someone else (the registry was lost and the other `a.b@`/`a-b@` signed in first), the
   * registry is corrected to that owner and the claim refused.
   */
  async #assertOwnerInGit(name: string, owner: string): Promise<void> {
    const recorded = await this.#ownerInGit(name)
    if (recorded === null || recorded === owner) return
    this.#registry.upsertSpace({ name, kind: 'personal', ownerEmail: recorded })
    throw new HearthError('forbidden', 'handle already claimed by another member')
  }

  /** The owner in `.hearth/space.yaml`; null for a new repo, or one whose config names nobody. */
  async #ownerInGit(name: string): Promise<string | null> {
    let text: string
    try {
      text = (await this.#git.readFile(name, SPACE_CONFIG)).content
    } catch (err) {
      if (err instanceof HearthError && err.code === 'not_found') return null
      throw err
    }
    try {
      return parseSpaceConfig(text).owner ?? null
    } catch (err) {
      // Same as the registry rebuild: a config that can't be read records no owner.
      this.#log(`${name}: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  /**
   * Makes sure the repo exists on the host. A space that is already cloned doesn't need the host
   * to be up: Hearth keeps serving the clone, with its remote URL, and syncs once the host is back.
   */
  async #cloneUrl(name: string): Promise<string> {
    let cloneUrl: string
    try {
      cloneUrl = (await this.#host.ensureRepo(name)).cloneUrl
    } catch (err) {
      // The URL carries the host credential; never log it.
      const existing = await this.#git.remoteUrl(name)
      if (existing === null) throw err
      this.#log(`${name}: couldn't ensure the repo on the host, using the existing clone: ${err}`)
      return existing
    }
    await this.#ensureWebhook(name)
    return cloneUrl
  }

  /** Idempotent on the host. Without the webhook, the poller still picks up outside pushes. */
  async #ensureWebhook(name: string): Promise<void> {
    if (this.#webhook === undefined) return
    try {
      await this.#host.ensureWebhook(name, this.#webhook.url, this.#webhook.secret)
    } catch (err) {
      this.#log(`${name}: couldn't register the webhook, relying on polling: ${err}`)
    }
  }
}
