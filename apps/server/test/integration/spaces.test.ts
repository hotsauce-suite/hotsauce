import { initialSpaceFiles } from '@hearth/format'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Principal } from '../../src/auth/index.js'
import { deriveHandle } from '../../src/auth/index.js'
import { HearthError } from '../../src/errors.js'
import { Index } from '../../src/index/index.js'
import {
  defaultInitialFiles,
  rebuildRegistryFromClones,
  SpaceService,
} from '../../src/spaces/index.js'
import { MemoryGit, MemoryHost } from '../fixtures/memory-git.js'

const HEARTH = { name: 'Hearth', email: 'hearth@example.test' }

function member(email: string, extra: Partial<Principal> = {}): Principal {
  return {
    userId: `user_${email}`,
    email,
    name: email.split('@')[0] ?? email,
    handle: deriveHandle(email),
    isAdmin: false,
    ...extra,
  }
}

const morgan = member('morgan@example.test')
const jo = member('jo@example.test')
const admin = member('admin@example.test', { isAdmin: true })

let git: MemoryGit
let host: MemoryHost
let registry: Index
let spaces: SpaceService

function newService(): SpaceService {
  return new SpaceService({ git, host, registry, committer: HEARTH })
}

beforeEach(() => {
  git = new MemoryGit()
  host = new MemoryHost()
  registry = new Index(':memory:')
  spaces = newService()
})

afterEach(() => {
  registry.close()
})

describe('ensureTeamSpace', () => {
  it('creates, clones and seeds the team repo authored by Hearth', async () => {
    expect(await spaces.ensureTeamSpace()).toEqual({ name: 'team', kind: 'team', label: 'Team' })
    expect(host.ensureRepoCalls).toEqual(['team'])
    expect(git.clones).toEqual([{ space: 'team', remoteUrl: 'file:///remotes/team.git' }])
    expect(git.commits).toEqual([
      {
        space: 'team',
        author: HEARTH,
        message: 'hearth: create space "team"',
        paths: ['README.md', '.hearth/space.yaml'],
      },
    ])
    expect(registry.getSpace('team')).toMatchObject({ kind: 'team', ownerEmail: null })
  })

  it('does not seed a repo that already has files', async () => {
    git.seed('team', { 'docs/existing.md': '# Existing\n' })
    await spaces.ensureTeamSpace()
    expect(git.commits).toEqual([])
  })
})

describe('ensurePersonalSpace', () => {
  it('first call provisions the handle repo, seeds it as the member, and records the owner', async () => {
    expect(await spaces.ensurePersonalSpace(morgan)).toEqual({
      name: 'morgan',
      kind: 'personal',
      label: 'Personal',
    })
    expect(host.ensureRepoCalls).toEqual(['morgan'])
    expect(git.commits).toEqual([
      {
        space: 'morgan',
        author: { name: morgan.name, email: morgan.email },
        message: 'hearth: create space "morgan"',
        paths: ['README.md', '.hearth/space.yaml'],
      },
    ])
    expect(registry.getSpace('morgan')).toMatchObject({
      kind: 'personal',
      ownerEmail: 'morgan@example.test',
    })
  })

  it('second call on the same instance does nothing', async () => {
    await spaces.ensurePersonalSpace(morgan)
    await spaces.ensurePersonalSpace(morgan)
    expect(host.ensureRepoCalls).toEqual(['morgan'])
    expect(git.commits).toHaveLength(1)
  })

  it('after a restart, re-ensures the repo but does not seed it again', async () => {
    await spaces.ensurePersonalSpace(morgan)
    await newService().ensurePersonalSpace(morgan)
    expect(host.ensureRepoCalls).toEqual(['morgan', 'morgan'])
    expect(git.commits).toHaveLength(1)
  })

  it('shares one provisioning between concurrent first requests', async () => {
    await Promise.all([spaces.ensurePersonalSpace(morgan), spaces.ensurePersonalSpace(morgan)])
    expect(host.ensureRepoCalls).toEqual(['morgan'])
    expect(git.commits).toHaveLength(1)
  })

  it('retries after a failed provisioning', async () => {
    let fail = true
    const ensureRepo = host.ensureRepo.bind(host)
    host.ensureRepo = async (name) => {
      if (fail) throw new HearthError('host_error', 'host down')
      return ensureRepo(name)
    }
    await expect(spaces.ensurePersonalSpace(morgan)).rejects.toMatchObject({ code: 'host_error' })
    fail = false
    await spaces.ensurePersonalSpace(morgan)
    expect(git.commits).toHaveLength(1)
  })

  it('after a restart with the host down, keeps serving the existing clones', async () => {
    await spaces.ensureTeamSpace()
    await spaces.ensurePersonalSpace(morgan)
    host.ensureRepo = async () => {
      throw new HearthError('host_error', 'host down')
    }
    const logs: string[] = []
    const restarted = new SpaceService({
      git,
      host,
      registry,
      committer: HEARTH,
      log: (m) => logs.push(m),
    })

    await restarted.ensureTeamSpace()
    await restarted.ensurePersonalSpace(morgan)

    expect(git.clones.slice(-2)).toEqual([
      { space: 'team', remoteUrl: 'file:///remotes/team.git' },
      { space: 'morgan', remoteUrl: 'file:///remotes/morgan.git' },
    ])
    expect((await restarted.visibleSpaces(morgan)).map((s) => s.name)).toEqual(['team', 'morgan'])
    const fallbacks = logs.filter((m) => m.includes('using the existing clone'))
    expect(fallbacks.map((m) => m.split(':')[0])).toEqual(['team', 'morgan'])
    expect(git.commits).toHaveLength(2)
  })

  it('lists only team while the personal space cannot be provisioned', async () => {
    const ensureRepo = host.ensureRepo.bind(host)
    host.ensureRepo = async () => {
      throw new HearthError('host_error', 'host down')
    }
    await expect(spaces.ensurePersonalSpace(jo)).rejects.toMatchObject({ code: 'host_error' })
    expect(await spaces.visibleSpaces(jo)).toEqual([{ name: 'team', kind: 'team', label: 'Team' }])

    host.ensureRepo = ensureRepo
    await spaces.ensurePersonalSpace(jo)
    expect((await spaces.visibleSpaces(jo)).map((s) => s.name)).toEqual(['team', 'jo'])
  })

  it('uses injected initial files, passing the kind and the owner', async () => {
    const calls: unknown[] = []
    const service = new SpaceService({
      git,
      host,
      registry,
      committer: HEARTH,
      initialFiles: (name, opts) => {
        calls.push({ name, ...opts })
        return [{ path: 'HELLO.md', content: `# ${name}\n` }]
      },
    })
    await service.ensurePersonalSpace(jo)
    await service.ensureTeamSpace()
    expect(git.commits[0]?.paths).toEqual(['HELLO.md'])
    expect((await git.readFile('jo', 'HELLO.md')).content).toBe('# jo\n')
    expect(calls).toEqual([
      { name: 'jo', kind: 'personal', owner: 'jo@example.test' },
      { name: 'team', kind: 'team' },
    ])
  })

  it('refuses a handle that would be the team repo', async () => {
    await expect(spaces.ensurePersonalSpace(member('team@example.test'))).rejects.toMatchObject({
      code: 'forbidden',
    })
    expect(host.ensureRepoCalls).toEqual([])
  })
})

describe('handle collisions', () => {
  const dotted = member('morgan.holland@example.test')
  const hyphenated = member('morgan-holland@example.test')

  it('the second member to claim a handle is refused and nothing is provisioned', async () => {
    expect(dotted.handle).toBe(hyphenated.handle)
    await spaces.ensurePersonalSpace(dotted)

    const attempt = spaces.ensurePersonalSpace(hyphenated)
    await expect(attempt).rejects.toBeInstanceOf(HearthError)
    await expect(attempt).rejects.toMatchObject({
      code: 'forbidden',
      message: 'handle already claimed by another member',
    })
    expect(host.ensureRepoCalls).toEqual(['morgan-holland'])
    expect(git.commits).toHaveLength(1)
    expect(registry.getSpace('morgan-holland')?.ownerEmail).toBe('morgan.holland@example.test')
  })

  it('takes the owner recorded in the repo’s space.yaml over the first claim', async () => {
    const files = initialSpaceFiles('morgan-holland', { kind: 'personal', owner: dotted.email })
    git.seed('morgan-holland', Object.fromEntries(files.map((f) => [f.path, f.content])))

    await expect(spaces.ensurePersonalSpace(hyphenated)).rejects.toMatchObject({
      code: 'forbidden',
    })
    expect(registry.getSpace('morgan-holland')?.ownerEmail).toBe(dotted.email)
    expect(spaces.canAccess(hyphenated, 'morgan-holland')).toBe(false)

    await spaces.ensurePersonalSpace(dotted)
    expect((await spaces.visibleSpaces(dotted)).map((s) => s.name)).toEqual([
      'team',
      'morgan-holland',
    ])
    expect(git.commits).toEqual([])
  })

  it('refuses the loser of a concurrent race for one handle', async () => {
    const results = await Promise.allSettled([
      spaces.ensurePersonalSpace(dotted),
      spaces.ensurePersonalSpace(hyphenated),
    ])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected'])
  })

  it('denies the colliding member access to the owner’s space and hides it from them', async () => {
    await spaces.ensurePersonalSpace(dotted)
    expect(spaces.canAccess(dotted, 'morgan-holland')).toBe(true)
    expect(spaces.canAccess(hyphenated, 'morgan-holland')).toBe(false)
    expect(await spaces.visibleSpaces(hyphenated)).toEqual([
      { name: 'team', kind: 'team', label: 'Team' },
    ])
  })

  it('is case-insensitive on the owner email', async () => {
    await spaces.ensurePersonalSpace(member('morgan@example.test'))
    const shouty = member('Morgan@Example.test')
    expect(shouty.handle).toBe('morgan')
    await expect(spaces.ensurePersonalSpace(shouty)).resolves.toMatchObject({ name: 'morgan' })
    expect(spaces.canAccess(shouty, 'morgan')).toBe(true)
    expect(git.commits).toHaveLength(1)
  })
})

describe('visibleSpaces', () => {
  it('lists team and the member’s own personal space', async () => {
    await spaces.ensurePersonalSpace(morgan)
    expect(await spaces.visibleSpaces(morgan)).toEqual([
      { name: 'team', kind: 'team', label: 'Team' },
      { name: 'morgan', kind: 'personal', label: 'Personal' },
    ])
  })

  it('finds the personal space by owner, not by handle', async () => {
    await spaces.ensurePersonalSpace(morgan)
    const renamed = { ...morgan, handle: 'something-else' }
    expect((await spaces.visibleSpaces(renamed)).map((s) => s.name)).toEqual(['team', 'morgan'])
  })

  it('lists only team before the personal space exists', async () => {
    expect(await spaces.visibleSpaces(jo)).toEqual([{ name: 'team', kind: 'team', label: 'Team' }])
  })
})

describe('canAccess', () => {
  beforeEach(async () => {
    await spaces.ensureTeamSpace()
    await spaces.ensurePersonalSpace(morgan)
    await spaces.ensurePersonalSpace(jo)
    await spaces.ensurePersonalSpace(admin)
  })

  it.each([
    ['morgan', 'team', true],
    ['jo', 'team', true],
    ['admin', 'team', true],
    ['morgan', 'morgan', true],
    ['morgan', 'jo', false],
    ['jo', 'jo', true],
    ['jo', 'morgan', false],
    ['admin', 'admin', true],
    ['admin', 'morgan', false],
    ['admin', 'jo', false],
    ['morgan', 'unknown', false],
    ['morgan', '', false],
  ])('%s → %s: %s', (who, space, allowed) => {
    const p = { morgan, jo, admin }[who as 'morgan' | 'jo' | 'admin']
    expect(spaces.canAccess(p, space)).toBe(allowed)
  })

  it('does not trust a handle that was never provisioned', () => {
    const newcomer = member('newcomer@example.test')
    expect(spaces.canAccess(newcomer, newcomer.handle)).toBe(false)
  })
})

describe('webhooks', () => {
  const webhook = { url: 'https://hearth.test/api/webhooks/git', secret: 'a'.repeat(32) }

  it('registers the push webhook on every space it provisions', async () => {
    const service = new SpaceService({ git, host, registry, committer: HEARTH, webhook })
    await service.ensureTeamSpace()
    await service.ensurePersonalSpace(morgan)
    expect(host.webhooks).toEqual([
      { name: 'team', ...webhook },
      { name: 'morgan', ...webhook },
    ])
  })

  it('provisions the space anyway when the webhook cannot be registered', async () => {
    host.ensureWebhook = async () => {
      throw new HearthError('host_error', 'hooks are down')
    }
    const logs: string[] = []
    const service = new SpaceService({
      git,
      host,
      registry,
      committer: HEARTH,
      webhook,
      log: (m) => logs.push(m),
    })
    await service.ensureTeamSpace()
    expect(git.commits).toHaveLength(1)
    expect(logs).toEqual([expect.stringMatching(/^team: couldn't register the webhook/)])
  })
})

describe('addCollaborator', () => {
  it('adds the member to team and to their own space', async () => {
    await spaces.ensurePersonalSpace(morgan)
    await spaces.addCollaborator(morgan, 'ada-gh')
    expect(host.collaborators).toEqual([
      { name: 'team', username: 'ada-gh' },
      { name: 'morgan', username: 'ada-gh' },
    ])
  })

  it('adds only team when the member has no personal space yet', async () => {
    await spaces.addCollaborator(jo, 'jo-gh')
    expect(host.collaborators).toEqual([{ name: 'team', username: 'jo-gh' }])
  })
})

describe('defaultInitialFiles', () => {
  it('writes a README and a space.yaml with the name quoted', () => {
    expect(defaultInitialFiles('123')).toEqual([
      { path: 'README.md', content: expect.stringMatching(/^# 123\n/) },
      { path: '.hearth/space.yaml', content: 'name: "123"\nschema: 1\n' },
    ])
  })
})

describe('rebuildRegistryFromClones', () => {
  /** MemoryGit with every seeded space counted as cloned. */
  function clones(files: Record<string, Record<string, string>>) {
    const memory = new MemoryGit()
    for (const [space, content] of Object.entries(files)) memory.seed(space, content)
    return Object.assign(memory, { listClones: async () => Object.keys(files).sort() })
  }

  it('restores owners from each space.yaml after the index is lost', async () => {
    const source = clones({
      team: Object.fromEntries(
        initialSpaceFiles('team', { kind: 'team' }).map((f) => [f.path, f.content]),
      ),
      morgan: Object.fromEntries(
        initialSpaceFiles('morgan', { kind: 'personal', owner: 'Morgan@example.test' }).map((f) => [
          f.path,
          f.content,
        ]),
      ),
    })
    const logs: string[] = []

    await rebuildRegistryFromClones(source, registry, (m) => logs.push(m))

    expect(registry.listSpaces()).toMatchObject([
      { name: 'morgan', kind: 'personal', ownerEmail: 'morgan@example.test' },
      { name: 'team', kind: 'team', ownerEmail: null },
    ])
    expect(spaces.canAccess(morgan, 'morgan')).toBe(true)
    expect(spaces.canAccess(jo, 'morgan')).toBe(false)
    expect(logs).toEqual([])
  })

  it('treats an older seed without kind/owner as team for team, unowned otherwise', async () => {
    registry.upsertSpace({ name: 'jo', kind: 'personal', ownerEmail: 'jo@example.test' })
    const source = clones({
      team: { '.hearth/space.yaml': 'name: "team"\nschema: 1\n' },
      jo: { '.hearth/space.yaml': 'name: "jo"\nschema: 1\n' },
      old: { '.hearth/space.yaml': 'name: "old"\nschema: 1\n' },
      bare: { 'README.md': '# no config\n' },
    })
    const logs: string[] = []

    await rebuildRegistryFromClones(source, registry, (m) => logs.push(m))

    expect(registry.getSpace('team')).toMatchObject({ kind: 'team', ownerEmail: null })
    // A row we already had is kept; a space nobody owns gets no row, so nobody can open it.
    expect(registry.getSpace('jo')).toMatchObject({ ownerEmail: 'jo@example.test' })
    expect(registry.getSpace('old')).toBeNull()
    expect(registry.getSpace('bare')).toBeNull()
    expect(spaces.canAccess(morgan, 'old')).toBe(false)
    const unowned = logs.filter((m) => m.includes('owned by nobody')).map((m) => m.split(':')[0])
    expect(unowned).toEqual(['bare', 'jo', 'old'])
  })
})
