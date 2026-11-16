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
  it('opens an index a newer release migrated, and keeps its stars and its version', () => {
    const file = path.join(dir, 'index.sqlite')
    const first = new Index(file)
    first.setStarred('u_alice', 'team', 'docs/plan.md', true)
    first.close()

    const raw = new Database(file)
    const { version } = raw.prepare('SELECT version FROM schema_version').get() as {
      version: number
    }
    raw.exec('ALTER TABLE pins ADD COLUMN added_by_a_newer_release TEXT')
    raw.prepare('UPDATE schema_version SET version = ?').run(version + 1)
    raw.close()

    const older = new Index(file)
    expect(older.listStars('u_alice').map((s) => s.path)).toEqual(['docs/plan.md'])
    older.close()

    const check = new Database(file)
    expect(check.prepare('SELECT version FROM schema_version').get()).toEqual({
      version: version + 1,
    })
    check.close()
  })
})
