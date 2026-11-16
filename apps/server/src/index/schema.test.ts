import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Index } from './db.js'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotsauce-index-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('the index after a rollback', () => {
  // A release that added a migration ran, then the updater put the previous release back.
  // Stars and pins now live in account.sqlite; the index keeps an older release's copy of them
  // (docs/PLAN-member-lists.md), so a rollback must not lose those either.
  it('is made again for this build, keeping the old stars, pins and the spaces', () => {
    const file = path.join(dir, 'index.sqlite')
    new Index(file).close()

    const raw = new Database(file)
    raw.prepare('INSERT INTO stars VALUES (?, ?, ?)').run('u_alice', 'team', 'docs/plan.md')
    raw.prepare('INSERT INTO pins VALUES (?, ?)').run('u_alice', '["docs","tasks"]')
    const { version } = raw.prepare('SELECT version FROM schema_version').get() as {
      version: number
    }
    raw.exec(`
      INSERT INTO spaces (name, kind, owner_email, created_at)
        VALUES ('alice', 'personal', 'alice@example.test', '2026-11-01T00:00:00.000Z');
      INSERT INTO sync_state (space, head_oid, synced_at) VALUES ('team', 'abc', '2026-11-16');
      ALTER TABLE pins ADD COLUMN added_by_a_newer_release TEXT;
      ALTER TABLE files ADD COLUMN added_by_a_newer_release TEXT;
      CREATE TABLE added_by_a_newer_release (id TEXT);
    `)
    raw.prepare('UPDATE schema_version SET version = ?').run(version + 1)
    raw.close()

    const older = new Index(file)
    const lists = older.legacyMemberLists()
    expect(lists.stars).toEqual([{ user: 'u_alice', space: 'team', path: 'docs/plan.md' }])
    expect(lists.pins).toEqual([{ user: 'u_alice', apps: '["docs","tasks"]' }])
    expect(older.listSpaces().map((s) => s.name)).toEqual(['alice'])
    // Nothing is marked as indexed, so every space is indexed again on start.
    expect(older.getSyncState('team')).toBeNull()
    older.close()

    const check = new Database(file)
    expect(check.prepare('SELECT version FROM schema_version').get()).toEqual({ version })
    const names = (table: string) =>
      (
        check.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]
      ).map((c) => c.name)
    expect(names('files')).not.toContain('added_by_a_newer_release')
    expect(names('added_by_a_newer_release')).toEqual([])
    check.close()

    // The newer release coming back opens it like any older index.
    new Index(file).close()
  })
})
