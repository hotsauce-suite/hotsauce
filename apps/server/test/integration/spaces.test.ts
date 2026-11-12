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

const ada = member('ada@example.test')
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
    expect(await spaces.ensurePersonalSpace(ada)).toEqual({
      name: 'ada',
      kind: 'personal',
      label: 'Personal',
    })
    expect(host.ensureRepoCalls).toEqual(['ada'])
    expect(git.commits).toEqual([
      {
        space: 'ada',
        author: { name: ada.name, email: ada.email },
        message: 'hearth: create space "ada"',
        paths: ['README.md', '.hearth/space.yaml'],
      },
    ])
    expect(registry.getSpace('ada')).toMatchObject({
      kind: 'personal',
      ownerEmail: 'ada@example.test',
    })
  })

  it('second call on the same instance does nothing', async () => {
    await spaces.ensurePersonalSpace(ada)
    await spaces.ensurePersonalSpace(ada)
    expect(host.ensureRepoCalls).toEqual(['ada'])
    expect(git.commits).toHaveLength(1)
  })

  it('after a restart, re-ensures the repo but does not seed it again', async () => {
    await spaces.ensurePersonalSpace(ada)
    await newService().ensurePersonalSpace(ada)
    expect(host.ensureRepoCalls).toEqual(['ada', 'ada'])
    expect(git.commits).toHaveLength(1)
  })

  it('shares one provisioning between concurrent first requests', async () => {
    await Promise.all([spaces.ensurePersonalSpace(ada), spaces.ensurePersonalSpace(ada)])
    expect(host.ensureRepoCalls).toEqual(['ada'])
    expect(git.commits).toHaveLength(1)
  })

  it('retries after a failed provisioning', async () => {
    let fail = true
    const ensureRepo = host.ensureRepo.bind(host)
    host.ensureRepo = async (name) => {
      if (fail) throw new HearthError('host_error', 'host down')
      return ensureRepo(name)
    }
    await expect(spaces.ensurePersonalSpace(ada)).rejects.toMatchObject({ code: 'host_error' })
    fail = false
    await spaces.ensurePersonalSpace(ada)
    expect(git.commits).toHaveLength(1)
  })

  it('after a restart with the host down, keeps serving the existing clones', async () => {
    await spaces.ensureTeamSpace()
    await spaces.ensurePersonalSpace(ada)
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
    await restarted.ensurePersonalSpace(ada)

    expect(git.clones.slice(-2)).toEqual([
      { space: 'team', remoteUrl: 'file:///remotes/team.git' },
      { space: 'ada', remoteUrl: 'file:///remotes/ada.git' },
    ])
    expect((await restarted.visibleSpaces(ada)).map((s) => s.name)).toEqual(['team', 'ada'])
    const fallbacks = logs.filter((m) => m.includes('using the existing clone'))
    expect(fallbacks.map((m) => m.split(':')[0])).toEqual(['team', 'ada'])
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
  const dotted = member('ada.lovelace@example.test')
  const hyphenated = member('ada-lovelace@example.test')

  it('the second member to claim a handle is refused and nothing is provisioned', async () => {
    expect(dotted.handle).toBe(hyphenated.handle)
    await spaces.ensurePersonalSpace(dotted)

    const attempt = spaces.ensurePersonalSpace(hyphenated)
    await expect(attempt).rejects.toBeInstanceOf(HearthError)
    await expect(attempt).rejects.toMatchObject({
      code: 'forbidden',
      message: 'handle already claimed by another member',
    })
    expect(host.ensureRepoCalls).toEqual(['ada-lovelace'])
    expect(git.commits).toHaveLength(1)
    expect(registry.getSpace('ada-lovelace')?.ownerEmail).toBe('ada.lovelace@example.test')
  })

  it('takes the owner recorded in the repo’s space.yaml over the first claim', async () => {
    const files = initialSpaceFiles('ada-lovelace', { kind: 'personal', owner: dotted.email })
    git.seed('ada-lovelace', Object.fromEntries(files.map((f) => [f.path, f.content])))

    await expect(spaces.ensurePersonalSpace(hyphenated)).rejects.toMatchObject({
      code: 'forbidden',
    })
    expect(registry.getSpace('ada-lovelace')?.ownerEmail).toBe(dotted.email)
    expect(spaces.canAccess(hyphenated, 'ada-lovelace')).toBe(false)

    await spaces.ensurePersonalSpace(dotted)
    expect((await spaces.visibleSpaces(dotted)).map((s) => s.name)).toEqual([
      'team',
      'ada-lovelace',
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
    expect(spaces.canAccess(dotted, 'ada-lovelace')).toBe(true)
    expect(spaces.canAccess(hyphenated, 'ada-lovelace')).toBe(false)
    expect(await spaces.visibleSpaces(hyphenated)).toEqual([
      { name: 'team', kind: 'team', label: 'Team' },
    ])
  })

  it('is case-insensitive on the owner email', async () => {
    await spaces.ensurePersonalSpace(member('ada@example.test'))
    const shouty = member('Ada@Example.test')
    expect(shouty.handle).toBe('ada')
    await expect(spaces.ensurePersonalSpace(shouty)).resolves.toMatchObject({ name: 'ada' })
    expect(spaces.canAccess(shouty, 'ada')).toBe(true)
    expect(git.commits).toHaveLength(1)
  })
})

describe('visibleSpaces', () => {
  it('lists team and the member’s own personal space', async () => {
    await spaces.ensurePersonalSpace(ada)
    expect(await spaces.visibleSpaces(ada)).toEqual([
      { name: 'team', kind: 'team', label: 'Team' },
      { name: 'ada', kind: 'personal', label: 'Personal' },
    ])
  })

  it('finds the personal space by owner, not by handle', async () => {
    await spaces.ensurePersonalSpace(ada)
    const renamed = { ...ada, handle: 'something-else' }
    expect((await spaces.visibleSpaces(renamed)).map((s) => s.name)).toEqual(['team', 'ada'])
  })

  it('lists only team before the personal space exists', async () => {
    expect(await spaces.visibleSpaces(jo)).toEqual([{ name: 'team', kind: 'team', label: 'Team' }])
  })
})

describe('canAccess', () => {
  beforeEach(async () => {
    await spaces.ensureTeamSpace()
    await spaces.ensurePersonalSpace(ada)
    await spaces.ensurePersonalSpace(jo)
    await spaces.ensurePersonalSpace(admin)
  })

  it.each([
    ['ada', 'team', true],
    ['jo', 'team', true],
    ['admin', 'team', true],
    ['ada', 'ada', true],
    ['ada', 'jo', false],
    ['jo', 'jo', true],
    ['jo', 'ada', false],
    ['admin', 'admin', true],
    ['admin', 'ada', false],
    ['admin', 'jo', false],
    ['ada', 'unknown', false],
    ['ada', '', false],
  ])('%s → %s: %s', (who, space, allowed) => {
    const p = { ada, jo, admin }[who as 'ada' | 'jo' | 'admin']
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
    await service.ensurePersonalSpace(ada)
    expect(host.webhooks).toEqual([
      { name: 'team', ...webhook },
      { name: 'ada', ...webhook },
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
    await spaces.ensurePersonalSpace(ada)
    await spaces.addCollaborator(ada, 'ada-gh')
    expect(host.collaborators).toEqual([
      { name: 'team', username: 'ada-gh' },
      { name: 'ada', username: 'ada-gh' },
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
      ada: Object.fromEntries(
        initialSpaceFiles('ada', { kind: 'personal', owner: 'Ada@example.test' }).map((f) => [
          f.path,
          f.content,
        ]),
      ),
    })
    const logs: string[] = []

    await rebuildRegistryFromClones(source, registry, (m) => logs.push(m))

    expect(registry.listSpaces()).toMatchObject([
      { name: 'ada', kind: 'personal', ownerEmail: 'ada@example.test' },
      { name: 'team', kind: 'team', ownerEmail: null },
    ])
    expect(spaces.canAccess(ada, 'ada')).toBe(true)
    expect(spaces.canAccess(jo, 'ada')).toBe(false)
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
    expect(spaces.canAccess(ada, 'old')).toBe(false)
    const unowned = logs.filter((m) => m.includes('owned by nobody')).map((m) => m.split(':')[0])
    expect(unowned).toEqual(['bare', 'jo', 'old'])
  })
})
