import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClipStore } from './store.js'

let store: ClipStore
const alice = { userId: 'u_alice', email: 'alice@example.test', name: 'Alice' }
const bob = { userId: 'u_bob', email: 'bob@example.test', name: 'Bob' }

beforeEach(() => {
  store = new ClipStore(':memory:')
})
afterEach(() => store.close())

function add(id: string, owner = alice, at = '2026-11-10T10:00:00.000Z') {
  return store.create({
    id,
    owner,
    title: `Clip ${id}`,
    mode: 'screen',
    container: 'webm',
    now: at,
  })
}

describe('ClipStore', () => {
  it('creates a recording and applies patches, keeping the transcript as JSON and text', () => {
    const clip = add('A')
    expect(clip).toMatchObject({ status: 'recording', titleSet: false, transcript: [] })
    const updated = store.update(
      'A',
      { status: 'ready', hasThumb: true, transcript: [{ start: 0, end: 1, text: 'hello world' }] },
      '2026-11-10T10:01:00.000Z',
    )
    expect(updated).toMatchObject({
      status: 'ready',
      hasThumb: true,
      transcript: [{ start: 0, end: 1, text: 'hello world' }],
      updatedAt: '2026-11-10T10:01:00.000Z',
    })
    expect(store.update('missing', { title: 'x' }, 'now')).toBeNull()
  })

  it('lists newest first; others’ clips only once processing or ready', () => {
    add('A', alice, '2026-11-10T10:00:00.000Z')
    add('B', bob, '2026-11-10T11:00:00.000Z')
    add('C', bob, '2026-11-10T12:00:00.000Z')
    store.update('A', { status: 'ready' }, 'now')
    store.update('B', { status: 'failed' }, 'now')
    store.update('C', { status: 'processing' }, 'now')
    const ids = (scope: 'mine' | 'team', userId = alice.userId) =>
      store.list({ userId, scope, limit: 10 }).map((c) => c.id)
    expect(ids('team')).toEqual(['C', 'A'])
    expect(ids('mine')).toEqual(['A'])
    expect(ids('mine', bob.userId)).toEqual(['C', 'B'])
  })

  it('survives being reopened (migrations run once)', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'clipstore-'))
    const file = join(dir, 'clips.sqlite')
    const one = new ClipStore(file)
    one.create({ id: 'X', owner: alice, title: 't', mode: 'camera', container: 'mp4', now: 'n' })
    one.close()
    const two = new ClipStore(file)
    expect(two.get('X')?.mode).toBe('camera')
    two.close()
    await rm(dir, { recursive: true, force: true })
  })
})

describe('ClipStore after a rollback', () => {
  // A release that added a migration ran, then the updater put the previous release back. The
  // older build must leave the version alone, or the next update runs that migration twice.
  it('opens a database a newer release migrated without lowering its version', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotsauce-clips-'))
    try {
      const file = path.join(dir, 'clips.sqlite')
      const first = new ClipStore(file)
      first.create({
        id: 'c1',
        owner: alice,
        title: 'Kept',
        mode: 'screen',
        container: 'webm',
        now: '2026-11-10T10:00:00.000Z',
      })
      first.close()

      const raw = new Database(file)
      const { version } = raw.prepare('SELECT version FROM schema_version').get() as {
        version: number
      }
      raw.exec('ALTER TABLE clips ADD COLUMN added_by_a_newer_release TEXT')
      raw.prepare('UPDATE schema_version SET version = ?').run(version + 1)
      raw.close()

      const older = new ClipStore(file)
      expect(older.get('c1')?.title).toBe('Kept')
      older.close()

      const check = new Database(file)
      expect(check.prepare('SELECT version FROM schema_version').get()).toEqual({
        version: version + 1,
      })
      check.close()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
