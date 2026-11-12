import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isDurable, StateMirror } from './mirror.js'
import { HttpStateRemote, MemoryStateRemote } from './remote.js'

const text = (b: Uint8Array | null | undefined) => (b ? Buffer.from(b).toString('utf8') : null)

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'state-mirror-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function put(rel: string, content: string | Buffer): Promise<void> {
  const file = path.join(dir, rel)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content)
}

describe('isDurable (R4)', () => {
  it.each([
    'org/settings.json',
    'org/secrets.json',
    'org/assets/logo.svg',
    'tokens/tokens.json',
    'push/state.json',
    'brief/members.json',
    'dictation.sqlite',
    'clips.sqlite',
    'calendar/cache.sqlite',
    'sessions/01ABC/meta.json',
    'sessions/01ABC/segments.jsonl',
  ])('keeps %s', (rel) => {
    expect(isDurable(rel)).toBe(true)
  })

  it.each([
    'repos/team/README.md',
    'index.sqlite',
    'dictation.sqlite-wal',
    'dictation.sqlite-shm',
    'clips/uploads/x/0.webm',
    'clips/work/x/video.mp4',
    'file-uploads/u1/chunk-0',
    'kept-audio/a.webm',
    'sessions/01ABC/me.pcm',
    'org/settings.json.tmp',
    '.state-tmp/a.sqlite',
    '../escape',
  ])('skips %s', (rel) => {
    expect(isDurable(rel)).toBe(false)
  })
})

describe('StateMirror', () => {
  it('R1: restores stored files that are missing, and keeps files already on disk', async () => {
    const remote = new MemoryStateRemote()
    await remote.put('org/settings.json', Buffer.from('{"stored":true}'))
    await remote.put('tokens/tokens.json', Buffer.from('{"tokens":[]}'))
    await remote.put('repos/team/x.md', Buffer.from('never restored'))
    await put('tokens/tokens.json', '{"local":true}')

    const mirror = new StateMirror({ dataDir: dir, remote, log: () => {} })
    expect(await mirror.restore()).toBe(1)
    expect(await readFile(path.join(dir, 'org/settings.json'), 'utf8')).toBe('{"stored":true}')
    expect(await readFile(path.join(dir, 'tokens/tokens.json'), 'utf8')).toBe('{"local":true}')
    await expect(readFile(path.join(dir, 'repos/team/x.md'))).rejects.toThrow()
  })

  it('R2: pushes new and changed files, skips unchanged ones, and deletes removed ones', async () => {
    const remote = new MemoryStateRemote()
    const puts: string[] = []
    const realPut = remote.put.bind(remote)
    remote.put = async (k, b) => {
      puts.push(k)
      await realPut(k, b)
    }
    const mirror = new StateMirror({ dataDir: dir, remote, log: () => {} })
    await put('org/settings.json', 'v1')
    await put('repos/team/a.md', 'not mirrored')
    await put('sessions/s1/me.pcm', 'audio')
    await put('sessions/s1/segments.jsonl', '{"t":"hi"}\n')

    await mirror.sync()
    expect(await remote.list()).toEqual(['org/settings.json', 'sessions/s1/segments.jsonl'])

    puts.length = 0
    await mirror.sync()
    expect(puts).toEqual([])

    await put('org/settings.json', 'v2-longer')
    await mirror.sync()
    expect(text(await remote.get('org/settings.json'))).toBe('v2-longer')

    await rm(path.join(dir, 'sessions'), { recursive: true })
    await mirror.sync()
    expect(await remote.list()).toEqual(['org/settings.json'])
  })

  it('R2: deletes a stored file that was restored and later removed on disk', async () => {
    const remote = new MemoryStateRemote()
    await remote.put('brief/members.json', Buffer.from('{}'))
    const mirror = new StateMirror({ dataDir: dir, remote, log: () => {} })
    await mirror.restore()
    await rm(path.join(dir, 'brief/members.json'))
    await mirror.sync()
    expect(await remote.list()).toEqual([])
  })

  it('never empties the store when the data directory is missing', async () => {
    const remote = new MemoryStateRemote()
    await remote.put('org/settings.json', Buffer.from('{}'))
    const mirror = new StateMirror({ dataDir: dir, remote, log: () => {} })
    await mirror.restore()
    await rm(dir, { recursive: true, force: true })
    await mirror.sync()
    expect(await remote.list()).toEqual(['org/settings.json'])
  })

  it('R3: copies a SQLite database consistently while a WAL connection holds uncommitted-to-main writes', async () => {
    const file = path.join(dir, 'clips.sqlite')
    const db = new Database(file)
    db.pragma('journal_mode = WAL')
    db.exec('CREATE TABLE t (v TEXT)')
    const insert = db.prepare('INSERT INTO t VALUES (?)')
    for (let i = 0; i < 50; i++) insert.run(`row ${i}`)

    const remote = new MemoryStateRemote()
    const mirror = new StateMirror({ dataDir: dir, remote, log: () => {} })
    await mirror.sync()
    expect(await remote.list()).toEqual(['clips.sqlite'])

    // A fresh disk gets a database with every row, though most were still in the WAL.
    const other = await mkdtemp(path.join(tmpdir(), 'state-restore-'))
    try {
      await new StateMirror({ dataDir: other, remote, log: () => {} }).restore()
      const copy = new Database(path.join(other, 'clips.sqlite'), { readonly: true })
      expect((copy.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n).toBe(50)
      copy.close()
    } finally {
      await rm(other, { recursive: true, force: true })
    }

    // A later write to the WAL is noticed and pushed.
    insert.run('row 50')
    await mirror.sync()
    const again = await mkdtemp(path.join(tmpdir(), 'state-restore-'))
    try {
      await new StateMirror({ dataDir: again, remote, log: () => {} }).restore()
      const copy = new Database(path.join(again, 'clips.sqlite'), { readonly: true })
      expect((copy.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n).toBe(51)
      copy.close()
    } finally {
      await rm(again, { recursive: true, force: true })
    }
    db.close()
  })

  it('R5: close() pushes the last change', async () => {
    const remote = new MemoryStateRemote()
    const mirror = new StateMirror({ dataDir: dir, remote, intervalMs: 60_000, log: () => {} })
    mirror.start()
    await put('push/state.json', '{"subs":1}')
    await mirror.close()
    expect(text(await remote.get('push/state.json'))).toBe('{"subs":1}')
  })

  it('keeps going when the store refuses one file, and retries it next time', async () => {
    const remote = new MemoryStateRemote()
    let fail = true
    const realPut = remote.put.bind(remote)
    remote.put = async (k, b) => {
      if (fail && k === 'a.json') throw new Error('boom')
      await realPut(k, b)
    }
    const logs: string[] = []
    const mirror = new StateMirror({ dataDir: dir, remote, log: (m) => logs.push(m) })
    await put('a.json', 'a')
    await put('b.json', 'b')
    await mirror.sync()
    expect(await remote.list()).toEqual(['b.json'])
    expect(logs.join('\n')).toContain('a.json not saved yet')
    fail = false
    await mirror.sync()
    expect(await remote.list()).toEqual(['a.json', 'b.json'])
  })

  it('refuses to restore when the store cannot be listed', async () => {
    const remote = new MemoryStateRemote()
    remote.list = async () => {
      throw new Error('down')
    }
    await expect(new StateMirror({ dataDir: dir, remote }).restore()).rejects.toThrow('down')
  })
})

describe('HttpStateRemote', () => {
  let server: Server
  let base: string
  const files = new Map<string, Buffer>()
  const auth: (string | undefined)[] = []

  beforeEach(async () => {
    files.clear()
    auth.length = 0
    server = createServer((req, res) => {
      auth.push(req.headers.authorization)
      const url = new URL(req.url ?? '/', 'http://x')
      if (url.pathname === '/state/list') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ keys: [...files.keys()] }))
        return
      }
      const key = url.pathname
        .replace(/^\/state\/o\//, '')
        .split('/')
        .map(decodeURIComponent)
        .join('/')
      if (req.method === 'GET') {
        const f = files.get(key)
        res.statusCode = f ? 200 : 404
        res.end(f ?? '')
      } else if (req.method === 'PUT') {
        const chunks: Buffer[] = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', () => {
          files.set(key, Buffer.concat(chunks))
          res.statusCode = 204
          res.end()
        })
      } else if (req.method === 'DELETE') {
        res.statusCode = files.delete(key) ? 204 : 404
        res.end()
      }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/state`
  })
  afterEach(async () => {
    await new Promise((r) => server.close(r))
  })

  it('speaks the four routes, with encoded keys and an optional token', async () => {
    const remote = new HttpStateRemote(`${base}/`, 'secret')
    await remote.put('org/assets/my logo.svg', Buffer.from('<svg/>'))
    expect(await remote.list()).toEqual(['org/assets/my logo.svg'])
    expect(text(await remote.get('org/assets/my logo.svg'))).toBe('<svg/>')
    expect(await remote.get('missing.json')).toBeNull()
    await remote.delete('org/assets/my logo.svg')
    await remote.delete('org/assets/my logo.svg')
    expect(await remote.list()).toEqual([])
    expect(auth.every((a) => a === 'Bearer secret')).toBe(true)
  })
})
