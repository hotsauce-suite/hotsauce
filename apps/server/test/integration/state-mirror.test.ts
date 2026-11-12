// The state mirror end to end (docs/PLAN-cloudflare-deploy.md R1, R5, R7, R8): a real server
// process on a disk that is thrown away between runs, as a Cloudflare Container's is, with a small
// HTTP store standing in for R2 behind the Worker.
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const SERVER_DIR = fileURLToPath(new URL('../..', import.meta.url))
const SETUP_PASSWORD = 'correct-horse-battery'

const files = new Map<string, Buffer>()
let store: Server
let storeUrl: string
const dirs: string[] = []

beforeAll(async () => {
  store = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/list') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ keys: [...files.keys()] }))
      return
    }
    const key = url.pathname
      .replace(/^\/o\//, '')
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
    } else {
      files.delete(key)
      res.statusCode = 204
      res.end()
    }
  })
  await new Promise<void>((r) => store.listen(0, '127.0.0.1', r))
  storeUrl = `http://127.0.0.1:${(store.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise((r) => store.close(r))
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const { port } = s.address() as AddressInfo
  await new Promise((r) => s.close(r))
  return port
}

interface Running {
  base: string
  dataDir: string
  child: ChildProcess
  output: () => string
}

async function start(extra: Record<string, string> = {}): Promise<Running> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'hotsauce-cf-'))
  dirs.push(dataDir)
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  let out = ''
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: SERVER_DIR,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: 'production',
      AUTH_MODE: 'clerk',
      HOST_KIND: 'local',
      DATA_DIR: dataDir,
      PORT: String(port),
      PUBLIC_URL: base,
      HOTSAUCE_MASTER_KEY: 'test-master-key',
      HOTSAUCE_SETUP_TOKEN: SETUP_PASSWORD,
      STATE_URL: storeUrl,
      STATE_SYNC_MS: '60000',
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (d) => {
    out += d
  })
  child.stderr?.on('data', (d) => {
    out += d
  })
  const deadline = Date.now() + 45_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${out}`)
    try {
      const res = await fetch(`${base}/api/health`)
      if (res.ok) break
    } catch {}
    if (Date.now() > deadline) throw new Error(`server didn't start:\n${out}`)
    await new Promise((r) => setTimeout(r, 250))
  }
  return { base, dataDir, child, output: () => out }
}

async function stop(r: Running): Promise<number | null> {
  const exited = new Promise<number | null>((res) => r.child.once('exit', (code) => res(code)))
  r.child.kill('SIGTERM')
  return exited
}

describe('state mirror across a lost disk', () => {
  it('keeps setup, keys and push keys when the container comes back on an empty disk', async () => {
    const first = await start()
    const headers = { 'x-setup-token': SETUP_PASSWORD, 'content-type': 'application/json' }

    // R7: the setup password from the environment claims the instance; a wrong one doesn't.
    expect(
      (await fetch(`${first.base}/api/setup/state`, { headers: { 'x-setup-token': 'nope' } }))
        .status,
    ).toBe(401)
    expect((await fetch(`${first.base}/api/setup/state`, { headers })).status).toBe(200)
    // The password the deployer chose is never printed.
    expect(first.output()).toContain('enter the setup password you chose')
    expect(first.output()).not.toContain(SETUP_PASSWORD)

    const save = await fetch(`${first.base}/api/setup/settings`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        orgName: 'Fieldwork',
        productName: 'Fieldwork Office',
        allowedDomains: 'fieldwork.example',
        adminEmails: ['rosa@fieldwork.example'],
        secrets: { ANTHROPIC_API_KEY: 'sk-ant-not-a-real-key-1234' },
      }),
    })
    expect(save.status).toBe(200)

    // R5: a SIGTERM flushes before the process exits, though the sync interval is a minute.
    expect(await stop(first)).toBe(0)
    expect([...files.keys()]).toEqual(
      expect.arrayContaining(['org/settings.json', 'org/secrets.json', 'push/vapid.json']),
    )
    expect([...files.keys()].some((k) => k.startsWith('repos/') || k === 'index.sqlite')).toBe(
      false,
    )
    // Keys stay sealed in the store.
    expect(files.get('org/secrets.json')?.toString()).not.toContain('sk-ant-not-a-real-key')
    const firstPush = await readFile(path.join(first.dataDir, 'push', 'vapid.json'), 'utf8')

    // R1: a new process on a brand-new disk comes back with everything.
    const second = await start()
    try {
      const state = (await (
        await fetch(`${second.base}/api/setup/state`, { headers })
      ).json()) as Record<string, unknown>
      expect(JSON.stringify(state)).toContain('Fieldwork Office')
      expect(JSON.stringify(state)).toContain('ANTHROPIC_API_KEY')
      // R8: the same push keys, so members' subscriptions keep working.
      expect(await readFile(path.join(second.dataDir, 'push', 'vapid.json'), 'utf8')).toBe(
        firstPush,
      )
      expect(second.output()).toMatch(/State restored from the store: [1-9]\d* file/)
    } finally {
      await stop(second)
    }
  })

  it('refuses a setup password shorter than 12 characters', async () => {
    await expect(start({ HOTSAUCE_SETUP_TOKEN: 'short' })).rejects.toThrow(/too short/)
  })
})
