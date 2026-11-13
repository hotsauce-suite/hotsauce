import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryObjectStore } from '../storage/s3.js'
import { restoreBackup } from './restore.js'
import { backupsToDelete, dateOfKey, stampOf } from './retention.js'
import { BackupService, backupHealth } from './service.js'
import { createSnapshot, inBackup } from './snapshot.js'

let root: string
let dataDir: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'hotsauce-backup-'))
  dataDir = path.join(root, 'data')
  await mkdir(dataDir)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function put(rel: string, body: string) {
  const file = path.join(dataDir, rel)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, body)
}

/** A data folder like a real server's, with a live WAL-mode database and a bare git repo. */
async function seed() {
  await put('org/settings.json', '{"orgName":"Acme"}')
  await put('tokens/tokens.json', '{}')
  await put('sessions/abc/meta.json', '{}')
  await put('sessions/abc/me.pcm', 'raw audio')
  await put('clips/uploads/x/0', 'chunk')
  await put('file-uploads/y/0', 'chunk')
  await put('index.sqlite', 'rebuildable')
  await put('notes.tmp', 'temp')
  const db = new Database(path.join(dataDir, 'clips.sqlite'))
  db.pragma('journal_mode = WAL')
  db.exec('create table clips (id text primary key, title text)')
  db.prepare('insert into clips values (?, ?)').run('c1', 'Quarterly review')
  // Left open: the row lives in the WAL until a checkpoint, as on a running server.
  const remote = path.join(dataDir, 'remotes', 'team.git')
  execFileSync('git', ['init', '-q', '--bare', remote])
  const clone = path.join(root, 'clone')
  execFileSync('git', ['clone', '-q', remote, clone])
  await writeFile(path.join(clone, 'plan.md'), '# Plan\n')
  execFileSync('git', ['-C', clone, 'add', '.'])
  execFileSync('git', [
    '-C',
    clone,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-qm',
    'docs',
  ])
  execFileSync('git', ['-C', clone, 'push', '-q', 'origin', 'HEAD'])
  return db
}

async function files(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...(await files(dir, child)))
    else out.push(child)
  }
  return out.sort()
}

describe('what goes in a backup (R3)', () => {
  it('keeps durable files and repositories, leaves out temporary and rebuildable ones', () => {
    for (const rel of [
      'org/settings.json',
      'remotes/team.git/HEAD',
      'repos/team/plan.md',
      'clips.sqlite',
      'kept-audio/m/me.wav',
      'sessions/a/meta.json',
    ])
      expect(inBackup(rel), rel).toBe(true)
    for (const rel of [
      'index.sqlite',
      'clips.sqlite-wal',
      'sessions/a/me.pcm',
      'clips/uploads/x',
      'file-uploads/y',
      '.backup-tmp/s',
      '.state-tmp/x',
      'a.tmp',
      'repos/team/.git/index.lock',
      '.before-restore-2026/org/settings.json',
      'lost+found/x',
    ])
      expect(inBackup(rel), rel).toBe(false)
  })

  it('archives a consistent copy of a live database, and the git history', async () => {
    const db = await seed()
    try {
      const snap = await createSnapshot(dataDir, { name: 't' })
      const out = path.join(root, 'out')
      await mkdir(out)
      execFileSync('tar', ['-xzf', snap.archive, '-C', out])
      const got = await files(out)
      expect(got).toContain('org/settings.json')
      expect(got).toContain('sessions/abc/meta.json')
      expect(got).toContain('.hotsauce-backup.json')
      expect(got.some((f) => f.startsWith('remotes/team.git/objects/'))).toBe(true)
      for (const gone of [
        'index.sqlite',
        'sessions/abc/me.pcm',
        'clips/uploads/x/0',
        'file-uploads/y/0',
        'notes.tmp',
        'clips.sqlite-wal',
      ])
        expect(got).not.toContain(gone)
      const copy = new Database(path.join(out, 'clips.sqlite'), { readonly: true })
      expect(copy.prepare('select title from clips').get()).toEqual({ title: 'Quarterly review' })
      copy.close()
      const log = execFileSync('git', [
        '-C',
        path.join(out, 'remotes/team.git'),
        'log',
        '--format=%s',
      ]).toString()
      expect(log.trim()).toBe('docs')
      expect(snap.files).toBe(got.length - 1)
    } finally {
      db.close()
    }
  })
})

describe('retention (R5)', () => {
  const day = (iso: string) => ({ key: `b/${stampOf(new Date(iso))}.tar.gz`, at: new Date(iso) })

  it('keeps 14 dailies and the newest of each of the last 8 weeks', () => {
    const now = new Date('2026-11-12T04:00:00Z')
    const all = Array.from({ length: 120 }, (_, i) =>
      day(new Date(now.getTime() - i * 86_400_000 - 3_600_000).toISOString()),
    )
    const gone = new Set(backupsToDelete(all, { now }).map((b) => b.key))
    const kept = all.filter((b) => !gone.has(b.key))
    // 14 newest (Oct 30 to Thu Nov 12, which cover this week and the two before), plus the
    // newest of each of the 5 earlier weeks in the 8-week window (Oct 25, 18, 11, 4, Sep 27).
    for (const b of all.slice(0, 14)) expect(gone.has(b.key)).toBe(false)
    expect(kept.length).toBe(14 + 5)
    const oldest = kept[kept.length - 1] as { at: Date }
    expect(now.getTime() - oldest.at.getTime()).toBeLessThan(8 * 7 * 86_400_000)
  })

  it('counts days, not backups: many in one afternoon don’t push older days out', () => {
    const now = new Date('2026-11-12T18:00:00Z')
    const older = Array.from({ length: 13 }, (_, i) =>
      day(new Date(Date.UTC(2026, 10, 11 - i, 3)).toISOString()),
    )
    const today = Array.from({ length: 10 }, (_, i) =>
      day(new Date(Date.UTC(2026, 10, 12, 8 + i)).toISOString()),
    )
    const gone = new Set(backupsToDelete([...older, ...today], { now }).map((b) => b.key))
    for (const b of older) expect(gone.has(b.key), b.key).toBe(false)
    expect(gone.has((today[9] as { key: string }).key)).toBe(false)
    expect(gone.size).toBe(9)
  })

  it('keeps everything when there are few', () => {
    expect(backupsToDelete([day('2026-11-01T03:00:00Z')])).toEqual([])
  })

  it('round-trips the stamp in a key', () => {
    const d = new Date('2026-11-13T03:04:05.678Z')
    expect(stampOf(d)).toBe('2026-11-13T030405Z')
    expect(dateOfKey(`backups/h/${stampOf(d)}.tar.gz`)?.toISOString()).toBe(
      '2026-11-13T03:04:05.000Z',
    )
    expect(dateOfKey('backups/h/latest.json')).toBeNull()
  })
})

describe('snapshot safety', () => {
  it('a file named .db that isn’t a database is copied, not a failure', async () => {
    await put('repos/team/Thumbs.db', 'not a database')
    await put('notes/Thumbs.db', 'also not')
    const snap = await createSnapshot(dataDir, { name: 't' })
    expect(snap.files).toBe(2)
  })

  it('copies each repository while that space’s writes are held, and checks it', async () => {
    const db = await seed()
    db.close()
    const locked: string[] = []
    const snap = await createSnapshot(dataDir, {
      name: 't',
      lockSpace: async (space, fn) => {
        locked.push(space)
        return fn()
      },
    })
    expect(locked).toEqual(['team'])
    expect(snap.files).toBeGreaterThan(5)
  })

  it('keeps a repository whose branches git has packed (empty refs folders) (R13)', async () => {
    const db = await seed()
    db.close()
    // A gc packs every ref into packed-refs and leaves refs/heads and refs/tags empty.
    const remote = path.join(dataDir, 'remotes/team.git')
    execFileSync('git', ['--git-dir', remote, 'pack-refs', '--all'])
    expect(await readdir(path.join(remote, 'refs/heads'))).toEqual([])
    const s3 = new MemoryObjectStore()
    const status = await new BackupService({
      dataDir,
      s3,
      prefix: 'backups/',
      instance: 'h',
      hour: 3,
      log: () => {},
    }).run()
    expect(status.lastError).toBeUndefined()
    const target = path.join(root, 'restored')
    await restoreBackup({ s3, key: status.lastKey as string, target })
    const restored = path.join(target, 'remotes/team.git')
    const log = execFileSync('git', ['--git-dir', restored, 'log', '--format=%s', 'HEAD'])
    expect(log.toString().trim()).toBe('docs')
  })

  it('keeps a working copy whose branches git has packed (R13)', async () => {
    const db = await seed()
    db.close()
    const clone = path.join(dataDir, 'repos/team')
    execFileSync('git', ['clone', '-q', path.join(dataDir, 'remotes/team.git'), clone])
    execFileSync('git', ['-C', clone, 'pack-refs', '--all'])
    const snap = await createSnapshot(dataDir, { name: 't' })
    expect(snap.files).toBeGreaterThan(5)
  })

  it('fails rather than upload a repository with missing objects', async () => {
    const db = await seed()
    db.close()
    // Lose an object every time it's copied, as a gc mid-repack would.
    const objects = path.join(dataDir, 'remotes/team.git/objects')
    const loose = (await readdir(objects)).filter((d) => /^[0-9a-f]{2}$/.test(d))
    await rm(path.join(objects, loose[0] as string), { recursive: true })
    await expect(createSnapshot(dataDir, { name: 't' })).rejects.toThrow(/didn't copy cleanly/)
  })
})

describe('BackupService (R4–R6)', () => {
  function service(s3: MemoryObjectStore, now: () => Date) {
    return new BackupService({
      dataDir,
      s3,
      prefix: 'backups/',
      instance: 'office.acme.test',
      hour: 3,
      now,
      log: () => {},
    })
  }

  it('uploads the archive and latest.json, and records success', async () => {
    const db = await seed()
    try {
      const s3 = new MemoryObjectStore()
      const status = await service(s3, () => new Date('2026-11-13T03:10:00Z')).run()
      expect(status.lastError).toBeUndefined()
      expect(status.lastKey).toBe('backups/office.acme.test/2026-11-13T031000Z.tar.gz')
      expect([...s3.objects.keys()].sort()).toEqual([
        'backups/office.acme.test/2026-11-13T031000Z.tar.gz',
        'backups/office.acme.test/latest.json',
      ])
      const status2 = JSON.parse(await readFile(path.join(dataDir, 'backup/status.json'), 'utf8'))
      expect(status2.lastSuccessAt).toBe('2026-11-13T03:10:00.000Z')
      expect(await readdir(dataDir)).not.toContain('.backup-tmp')
    } finally {
      db.close()
    }
  })

  it('records a failure and prunes nothing', async () => {
    await put('org/settings.json', '{}')
    const s3 = new MemoryObjectStore()
    for (let i = 1; i <= 30; i++) {
      s3.objects.set(
        `backups/office.acme.test/2026-10-${String(i).padStart(2, '0')}T030000Z.tar.gz`,
        { body: new Uint8Array(1), at: '' },
      )
    }
    s3.put = async () => {
      throw new Error('bucket says no')
    }
    const status = await service(s3, () => new Date('2026-11-13T03:10:00Z')).run()
    expect(status.lastError).toContain('bucket says no')
    expect(s3.objects.size).toBe(30)
  })

  it('a backup cut off by a restart is not recorded as a failure', async () => {
    await put('org/settings.json', '{}')
    const s3 = new MemoryObjectStore()
    s3.putFile = (
      _key: string,
      _file: string,
      _size: number,
      _type: string,
      signal?: AbortSignal,
    ) =>
      new Promise<void>((_, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')))
      })
    const svc = service(s3, () => new Date('2026-11-13T03:10:00Z'))
    const running = svc.run()
    await new Promise((r) => setTimeout(r, 200))
    await svc.close()
    await running
    const status = await svc.status()
    expect(status.lastError).toBeUndefined()
    expect(backupHealth(status, new Date('2026-11-13T03:20:00Z')).ok).toBe(true)
  })

  it('waits an hour after a failure before trying again', async () => {
    await put('org/settings.json', '{}')
    const s3 = new MemoryObjectStore()
    const put0 = s3.put.bind(s3)
    s3.put = async () => {
      throw new Error('bucket says no')
    }
    let now = new Date('2026-11-13T03:10:00Z')
    const svc = service(s3, () => now)
    await svc.run()
    now = new Date('2026-11-13T03:40:00Z')
    expect(await svc.due()).toBe(false)
    now = new Date('2026-11-13T04:15:00Z')
    expect(await svc.due()).toBe(true)
    s3.put = put0
    expect((await svc.run()).lastError).toBeUndefined()
  })

  it('prunes old backups after a good one', async () => {
    await put('org/settings.json', '{}')
    const s3 = new MemoryObjectStore()
    for (let i = 1; i <= 30; i++) {
      s3.objects.set(
        `backups/office.acme.test/2026-10-${String(i).padStart(2, '0')}T030000Z.tar.gz`,
        { body: new Uint8Array(1), at: '' },
      )
    }
    s3.objects.set('backups/other.host/2026-01-01T030000Z.tar.gz', {
      body: new Uint8Array(1),
      at: '',
    })
    await service(s3, () => new Date('2026-11-13T03:10:00Z')).run()
    const mine = (await s3.list('backups/office.acme.test/')).filter((o) =>
      o.key.endsWith('.tar.gz'),
    )
    expect(mine.length).toBeLessThan(31)
    expect(mine.length).toBeGreaterThanOrEqual(14)
    expect(s3.objects.has('backups/other.host/2026-01-01T030000Z.tar.gz')).toBe(true)
  })

  it('is due once a day after the hour, and when stale', async () => {
    await put('org/settings.json', '{}')
    const s3 = new MemoryObjectStore()
    let now = new Date('2026-11-13T02:00:00Z')
    const svc = service(s3, () => now)
    expect(await svc.due()).toBe(true) // never backed up
    await svc.run()
    expect(await svc.due()).toBe(false) // 02:00, before the hour, just done
    now = new Date('2026-11-13T03:05:00Z')
    expect(await svc.due()).toBe(true) // past the hour, last one before it
    await svc.run()
    now = new Date('2026-11-13T23:00:00Z')
    expect(await svc.due()).toBe(false)
    now = new Date('2026-11-14T03:00:00Z')
    expect(await svc.due()).toBe(true)
  })
})

describe('restore (R7, R8)', () => {
  it('reproduces the data folder, and a database by content', async () => {
    const db = await seed()
    const s3 = new MemoryObjectStore()
    try {
      const status = await new BackupService({
        dataDir,
        s3,
        prefix: 'backups/',
        instance: 'h',
        hour: 3,
        log: () => {},
      }).run()
      const target = path.join(root, 'restored')
      const { manifest } = await restoreBackup({ s3, key: status.lastKey as string, target })
      const want = (await files(dataDir)).filter(inBackup)
      const got = await files(target)
      expect(got).toEqual(want.filter((f) => f !== 'backup/status.json' || got.includes(f)))
      expect(manifest.files).toBe(got.length)
      for (const f of want.filter((f) => !f.endsWith('.sqlite') && f !== 'backup/status.json')) {
        expect(await readFile(path.join(target, f)), f).toEqual(
          await readFile(path.join(dataDir, f)),
        )
      }
      const copy = new Database(path.join(target, 'clips.sqlite'), { readonly: true })
      expect(copy.prepare('select id, title from clips').all()).toEqual([
        { id: 'c1', title: 'Quarterly review' },
      ])
      copy.close()
      // A clone of the restored repository has the document.
      const clone = path.join(root, 'check')
      execFileSync('git', ['clone', '-q', path.join(target, 'remotes/team.git'), clone])
      expect(await readFile(path.join(clone, 'plan.md'), 'utf8')).toBe('# Plan\n')
    } finally {
      db.close()
    }
  })

  it('refuses a folder that has data, and with force moves it aside', async () => {
    await put('org/settings.json', '{"orgName":"Old"}')
    const s3 = new MemoryObjectStore()
    const status = await new BackupService({
      dataDir,
      s3,
      prefix: 'backups/',
      instance: 'h',
      hour: 3,
      log: () => {},
    }).run()
    await put('org/settings.json', '{"orgName":"Changed since"}')
    await expect(
      restoreBackup({ s3, key: status.lastKey as string, target: dataDir }),
    ).rejects.toThrow(/isn't empty/)
    const { movedAside } = await restoreBackup({
      s3,
      key: status.lastKey as string,
      target: dataDir,
      force: true,
    })
    expect(await readFile(path.join(dataDir, 'org/settings.json'), 'utf8')).toBe(
      '{"orgName":"Old"}',
    )
    expect(await readFile(path.join(movedAside as string, 'org/settings.json'), 'utf8')).toBe(
      '{"orgName":"Changed since"}',
    )
  })

  it('refuses something that isn’t a backup', async () => {
    const s3 = new MemoryObjectStore()
    const junk = path.join(root, 'junk')
    await mkdir(junk)
    await writeFile(path.join(junk, 'x'), 'x')
    execFileSync('tar', ['-czf', path.join(root, 'junk.tar.gz'), '-C', junk, '.'])
    await s3.put('k.tar.gz', await readFile(path.join(root, 'junk.tar.gz')), 0, '')
    await expect(
      restoreBackup({ s3, key: 'k.tar.gz', target: path.join(root, 'r') }),
    ).rejects.toThrow()
    await expect(
      restoreBackup({ s3, key: 'missing', target: path.join(root, 'r') }),
    ).rejects.toThrow(/no backup/)
  })
})

describe('backup health, for an outside monitor (R14)', () => {
  const now = new Date('2026-11-13T12:00:00Z')
  it('is ok after a good backup, and stale after 26 hours without one', () => {
    const at = '2026-11-13T03:10:00Z'
    expect(backupHealth({ lastAttemptAt: at, lastSuccessAt: at }, now).state).toBe('ok')
    const late = new Date('2026-11-14T05:20:00Z')
    expect(backupHealth({ lastAttemptAt: at, lastSuccessAt: at }, late)).toEqual({
      ok: false,
      state: 'stale',
    })
  })

  it('is failing as soon as the newest attempt failed, and ok again after a good one', () => {
    const failed = backupHealth(
      {
        lastSuccessAt: '2026-11-13T03:10:00Z',
        lastAttemptAt: '2026-11-13T11:00:00Z',
        lastError: 'bucket says no',
      },
      now,
    )
    expect(failed.ok).toBe(false)
    expect(failed.state).toBe('failing')
    // The error text stays private: the check is public.
    expect(JSON.stringify(failed)).not.toContain('bucket')
    expect(
      backupHealth(
        {
          lastSuccessAt: '2026-11-13T11:30:00Z',
          lastAttemptAt: '2026-11-13T11:30:00Z',
        },
        now,
      ).ok,
    ).toBe(true)
  })

  it('is pending before the first backup, and off without a bucket', () => {
    expect(backupHealth({}, now)).toEqual({ ok: true, state: 'pending' })
    expect(backupHealth(null, now)).toEqual({ ok: true, state: 'off' })
  })
})
