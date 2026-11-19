import { join } from 'node:path'
import { fileStoreKey } from '@hotsauce/format'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { runGit } from '../../src/git/index.js'
import { FakeLLM, scriptedResponse } from '../../src/meetings/index.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

// Files that delete themselves (docs/PLAN-screenshots.md R1 to R3).

const ALICE = 'alice@example.test'
const DAY = 86_400_000
const START = Date.parse('2026-11-19T12:00:00Z')

let root: string
let services: Services
let app: ReturnType<typeof createApp>
let now: number

beforeEach(async () => {
  root = await makeTempDir('hotsauce-files-expiry-')
  now = START
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.test',
    AUDIO_STORE: 'local',
  })
  services = createServices(config, {
    llm: new FakeLLM(scriptedResponse),
    filesNow: () => new Date(now),
  })
  await services.spaces.ensureTeamSpace()
  app = createApp(services)
  await call('GET', '/api/me')
})

afterEach(async () => {
  services.files.close()
  services.index.close()
  services.dictation.store.close()
  await removeDir(root)
})

async function call(method: string, url: string, json?: unknown, body?: Uint8Array) {
  const headers: Record<string, string> = { 'x-hearth-dev-user': ALICE }
  if (json !== undefined) headers['content-type'] = 'application/json'
  return app.request(url, {
    method,
    headers,
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    ...(body !== undefined ? { body: body as BodyInit } : {}),
  })
}

// biome-ignore lint/suspicious/noExplicitAny: response shapes are checked by the assertions
async function api<T = any>(method: string, url: string, json?: unknown, status = 200): Promise<T> {
  const res = await call(method, url, json)
  const text = await res.text()
  expect(res.status, `${method} ${url} → ${text}`).toBe(status)
  return (text ? JSON.parse(text) : null) as T
}

async function upload(name: string, deleteAfterDays?: number) {
  const bytes = new TextEncoder().encode(`picture ${name}`)
  const started = await api(
    'POST',
    '/api/files/uploads',
    { space: 'team', folder: 'Screenshots', name, size: bytes.length, deleteAfterDays },
    201,
  )
  expect(
    (await call('PUT', `/api/files/uploads/${started.id}/chunks/0`, undefined, bytes)).status,
  ).toBe(204)
  return api('POST', `/api/files/uploads/${started.id}/complete`)
}

const names = async () =>
  (await api('GET', '/api/files?space=team&folder=Screenshots')).files.map(
    (f: { name: string }) => f.name,
  )

describe('files that delete themselves', () => {
  it('R1: an upload can name its days, and the file says when it goes', async () => {
    const f = await upload('shot.png', 30)
    expect(f.deleteAfter).toBe('2026-12-19T12:00:00Z')
    expect((await upload('stays.png')).deleteAfter).toBeNull()
    for (const days of [0, 366, 1.5]) {
      await api(
        'POST',
        '/api/files/uploads',
        { space: 'team', name: 'x.png', size: 1, deleteAfterDays: days },
        400,
      )
    }
  })

  it('R2: the sweep deletes a file past its time, with its bytes and its link', async () => {
    const shot = await upload('shot.png', 30)
    await upload('stays.png')
    const later = await upload('later.png', 60)
    const shared = await api('POST', `/api/files/item/team/${shot.id}/share`, {
      on: true,
      expiresDays: 30,
    })
    const token = shared.shareToken as string
    expect(services.shareLinks.get(token)).not.toBeNull()

    now = START + 29 * DAY
    expect(await services.files.expire()).toBe(0)
    expect((await names()).sort()).toEqual(['later.png', 'shot.png', 'stays.png'])

    now = START + 30 * DAY + 1000
    expect(await services.files.expire()).toBe(1)
    expect((await names()).sort()).toEqual(['later.png', 'stays.png'])
    await api('GET', `/api/files/item/team/${shot.id}`, undefined, 404)
    expect(await services.meetings.audioStore?.get(fileStoreKey(shot.id))).toBeNull()
    expect(services.shareLinks.get(token)).toBeNull()
    // Not in the trash either: the pointer is gone from the tree.
    const tree = await runGit(join(root, 'remotes', 'team.git'), [
      'ls-tree',
      '-r',
      '--name-only',
      'main',
    ])
    expect(tree).not.toContain(shot.id)
    expect(tree).toContain(later.id)
    // A second pass has nothing to do.
    expect(await services.files.expire()).toBe(0)
  })

  it('R3: Keep stops it', async () => {
    const shot = await upload('shot.png', 30)
    const kept = await api('PATCH', `/api/files/item/team/${shot.id}`, { keep: true })
    expect(kept.deleteAfter).toBeNull()
    now = START + 400 * DAY
    expect(await services.files.expire()).toBe(0)
    expect(await names()).toEqual(['shot.png'])
    // Keeping a file that already stays changes nothing.
    const again = await api('PATCH', `/api/files/item/team/${shot.id}`, { keep: true })
    expect(again.blobOid).toBe(kept.blobOid)
  })
})
