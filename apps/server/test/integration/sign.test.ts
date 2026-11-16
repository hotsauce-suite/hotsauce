import { join } from 'node:path'
import { getDocumentProxy } from 'unpdf'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { makeTestPdf } from '../../src/links/test-pdf.js'
import { FakeLLM, scriptedResponse } from '../../src/meetings/index.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

// Sign, slice 2 (docs/PLAN-sign.md R7–R9) through the API with dev auth: a member makes an envelope
// from a PDF in Files, places fields, signs it, and the sealed PDF and certificate land in Files.

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'
// A 1×1 PNG, standing in for a drawn signature.
const DRAWN =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

let root: string
let services: Services
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  root = await makeTempDir('hotsauce-sign-')
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.test',
    ORG_NAME: 'Fieldwork',
    PUBLIC_URL: 'https://hotsauce.example.test',
  })
  services = createServices(config, { llm: new FakeLLM(scriptedResponse) })
  await services.spaces.ensureTeamSpace()
  app = createApp(services)
})

afterEach(async () => {
  await services.meetings.sessions.close()
  services.meetings.calendarSync?.cache.close()
  services.index.close()
  services.dictation.store.close()
  await removeDir(root)
})

// biome-ignore lint/suspicious/noExplicitAny: response shapes are checked by the assertions
async function api<T = any>(
  method: string,
  path: string,
  opts: { as?: string; json?: unknown; status?: number; agent?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'x-hearth-dev-user': opts.as ?? ALICE }
  if (opts.json !== undefined) headers['content-type'] = 'application/json'
  if (opts.agent) headers['user-agent'] = opts.agent
  const res = await app.request(path, {
    method,
    headers,
    ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
  })
  const type = res.headers.get('content-type') ?? ''
  if (type.includes('pdf')) {
    expect(res.status).toBe(opts.status ?? 200)
    return new Uint8Array(await res.arrayBuffer()) as T
  }
  const text = await res.text()
  expect(res.status, `${method} ${path} → ${text}`).toBe(opts.status ?? 200)
  return (text && type.includes('json') ? JSON.parse(text) : text) as T
}

async function upload(name: string, bytes: Uint8Array, space = 'team', as = ALICE) {
  // The member's personal space exists once they have made a request.
  await api('GET', '/api/sign', { as })
  const who = { name: as.split('@')[0] ?? as, email: as }
  return services.files.storeFormFile(who, { space, folder: 'Contracts', name, bytes })
}

const offer = () => makeTestPdf([['Offer letter', 'Sign below.'], ['Page two']], 'Offer letter')

async function draft(as = ALICE) {
  const file = await upload('offer.pdf', offer(), 'team', as)
  const env = await api('POST', '/api/sign', { as, json: { fileSpace: 'team', fileId: file.id } })
  return { file, env }
}

const FIELDS = [
  { id: 'f1', signer: 's1', type: 'signature', page: 1, x: 0.1, y: 0.7, width: 0.3, height: 0.06 },
  { id: 'f2', signer: 's1', type: 'date', page: 1, x: 0.5, y: 0.7, width: 0.2, height: 0.04 },
  { id: 'f3', signer: 's1', type: 'checkbox', page: 2, x: 0.1, y: 0.2, width: 0.04, height: 0.03 },
  { id: 'f4', signer: 's1', type: 'text', page: 2, x: 0.1, y: 0.3, width: 0.5, height: 0.04 },
]

async function textOf(pdf: Uint8Array): Promise<string> {
  const doc = await getDocumentProxy(new Uint8Array(pdf))
  const out: string[] = []
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent()
    out.push(content.items.map((i) => ('str' in i ? i.str : '')).join(' '))
  }
  await doc.cleanup()
  return out.join('\n')
}

describe('an envelope is one file in Git (R7)', () => {
  it('makes a draft in the member’s personal space from a PDF in Files', async () => {
    const { file, env } = await draft()
    expect(env).toMatchObject({
      space: 'alice',
      status: 'draft',
      title: 'offer',
      sourceName: 'offer.pdf',
      source: { file: file.id, space: 'team', sha256: file.sha256, size: file.size },
      signerList: [{ id: 's1', email: ALICE, status: 'pending' }],
      fields: [],
      auditIntact: true,
      canSign: false,
    })
    expect(env.source.pages).toEqual([
      { width: 612, height: 792 },
      { width: 612, height: 792 },
    ])
    expect(env.audit.map((a: { event: string }) => a.event)).toEqual(['created'])
    const list = await api('GET', '/api/sign')
    expect(list.envelopes.map((e: { id: string }) => e.id)).toEqual([env.id])
    expect(services.index.getFile('alice', `sign/${env.id}.md`)).toMatchObject({ kind: 'envelope' })
  })

  it('is private to its sender', async () => {
    const { env } = await draft()
    await api('GET', `/api/sign/alice/${env.id}`, { as: BOB, status: 403 })
    expect((await api('GET', '/api/sign', { as: BOB })).envelopes).toEqual([])
  })

  it('survives a full reindex from Git', async () => {
    const { env } = await draft()
    services.index.reindexSpace('alice', [])
    expect((await api('GET', '/api/sign')).envelopes).toEqual([])
    await services.indexer.full('alice')
    expect((await api('GET', '/api/sign')).envelopes.map((e: { id: string }) => e.id)).toEqual([
      env.id,
    ])
  })

  it('refuses a file that isn’t a PDF, and one that isn’t really a PDF', async () => {
    const note = await upload('note.txt', new TextEncoder().encode('hello'))
    await api('POST', '/api/sign', {
      json: { fileSpace: 'team', fileId: note.id },
      status: 400,
    })
    const fake = await upload('fake.pdf', new TextEncoder().encode('not a pdf at all'))
    const res = await api('POST', '/api/sign', {
      json: { fileSpace: 'team', fileId: fake.id },
      status: 400,
    })
    expect(res.error.message).toMatch(/can’t be opened/)
  })

  it('serves the source PDF to the sender for placing fields', async () => {
    const { env } = await draft()
    const pdf = await api<Uint8Array>('GET', `/api/sign/alice/${env.id}/source.pdf`)
    expect(Buffer.from(pdf).equals(Buffer.from(offer()))).toBe(true)
  })
})

describe('placing fields on a draft', () => {
  it('saves fields, refuses a field off the PDF’s pages, and refuses an old version', async () => {
    const { env } = await draft()
    const saved = await api('PUT', `/api/sign/alice/${env.id}`, {
      json: { title: 'Offer for Maya', fields: FIELDS, blobOid: env.blobOid },
    })
    expect(saved.title).toBe('Offer for Maya')
    expect(saved.fields).toHaveLength(4)
    expect(saved.canSign).toBe(true)
    const off = await api('PUT', `/api/sign/alice/${env.id}`, {
      json: { title: 'x', fields: [{ ...FIELDS[0], page: 3 }], blobOid: saved.blobOid },
      status: 400,
    })
    expect(off.error.message).toMatch(/page 3/)
    await api('PUT', `/api/sign/alice/${env.id}`, {
      json: { title: 'x', fields: FIELDS, blobOid: env.blobOid },
      status: 409,
    })
  })

  it('won’t take filled-in values while placing', async () => {
    const { env } = await draft()
    const saved = await api('PUT', `/api/sign/alice/${env.id}`, {
      json: {
        title: 'Offer',
        fields: [{ ...FIELDS[0], value: 'Forged', input: 'typed' }],
        blobOid: env.blobOid,
      },
    })
    expect(saved.fields[0].value).toBeUndefined()
  })
})

describe('signing it yourself (R9)', () => {
  async function ready() {
    const made = await draft()
    const env = await api('PUT', `/api/sign/alice/${made.env.id}`, {
      json: { title: 'Offer for Maya', fields: FIELDS, blobOid: made.env.blobOid },
    })
    return { ...made, env }
  }

  it('needs a signature field before anyone can sign', async () => {
    const { env } = await draft()
    const res = await api('POST', `/api/sign/alice/${env.id}/sign`, {
      json: { values: [], consent: true, blobOid: env.blobOid },
      status: 400,
    })
    expect(res.error.message).toMatch(/signature field/)
  })

  it('needs consent and a signature', async () => {
    const { env } = await ready()
    await api('POST', `/api/sign/alice/${env.id}/sign`, {
      json: { values: [{ field: 'f1', value: 'Alice' }], consent: false, blobOid: env.blobOid },
      status: 400,
    })
    const res = await api('POST', `/api/sign/alice/${env.id}/sign`, {
      json: { values: [{ field: 'f4', value: 'x' }], consent: true, blobOid: env.blobOid },
      status: 400,
    })
    expect(res.error.message).toMatch(/Add your signature/)
  })

  it('seals the signed PDF and its certificate into Files beside the original', async () => {
    const { file, env } = await ready()
    const done = await api('POST', `/api/sign/alice/${env.id}/sign`, {
      agent: 'Mozilla/5.0 (Test)',
      json: {
        consent: true,
        blobOid: env.blobOid,
        values: [
          { field: 'f1', value: 'Alice Archer' },
          { field: 'f3', checked: true },
          { field: 'f4', value: 'Санкт-Петербург' },
        ],
      },
    })
    expect(done).toMatchObject({
      status: 'completed',
      canSign: false,
      auditIntact: true,
      signerList: [{ id: 's1', status: 'signed' }],
      result: { space: 'team' },
    })
    expect(done.audit.map((a: { event: string }) => a.event)).toEqual([
      'created',
      'consented',
      'signed',
      'completed',
    ])
    expect(done.audit[2]).toMatchObject({ email: ALICE, agent: 'Mozilla/5.0 (Test)' })
    const date = done.fields.find((f: { id: string }) => f.id === 'f2')
    expect(date.value).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    const listing = await api('GET', '/api/files?space=team&folder=Contracts')
    const names = listing.files.map((f: { name: string }) => f.name).sort()
    expect(names).toEqual(['offer (certificate).pdf', 'offer (signed).pdf', 'offer.pdf'])

    const signed = await services.files.bytes('team', done.result.signedFile, 50_000_000)
    const certificate = await services.files.bytes('team', done.result.certificateFile, 50_000_000)
    if (!signed || !certificate) throw new Error('missing output')
    for (const pdf of [signed, certificate]) {
      expect(Buffer.from(pdf).toString('latin1')).toMatch(/\/SubFilter\s*\/ETSI\.CAdES\.detached/)
    }
    const signedText = await textOf(signed)
    expect(signedText).toContain('Alice Archer')
    expect(signedText).toContain('Санкт-Петербург')
    const certText = await textOf(certificate)
    expect(certText).toContain('Offer for Maya')
    expect(certText).toContain(file.sha256.slice(0, 16))

    // The original is untouched, and a finished envelope can't be signed again or edited.
    expect((await services.files.bytes('team', file.id, 50_000_000))?.length).toBe(file.size)
    await api('POST', `/api/sign/alice/${env.id}/sign`, {
      json: { values: [{ field: 'f1', value: 'Again' }], consent: true, blobOid: done.blobOid },
      status: 409,
    })
    await api('PUT', `/api/sign/alice/${env.id}`, {
      json: { title: 'x', fields: FIELDS, blobOid: done.blobOid },
      status: 409,
    })
  })

  it('takes a drawn signature', async () => {
    const { env } = await ready()
    const done = await api('POST', `/api/sign/alice/${env.id}/sign`, {
      json: {
        consent: true,
        blobOid: env.blobOid,
        values: [
          { field: 'f1', image: DRAWN },
          { field: 'f4', value: 'Lab 2' },
        ],
      },
    })
    expect(done.fields[0]).toMatchObject({ input: 'drawn', image: DRAWN })
    expect(done.status).toBe('completed')
  })

  it('refuses a drawn signature that isn’t a PNG', async () => {
    const { env } = await ready()
    await api('POST', `/api/sign/alice/${env.id}/sign`, {
      json: {
        consent: true,
        blobOid: env.blobOid,
        values: [
          { field: 'f1', image: 'data:image/png;base64,AAAA' },
          { field: 'f4', value: 'x' },
        ],
      },
      status: 400,
    })
  })

  it('reuses the install’s seal key from the data folder', async () => {
    const { env } = await ready()
    await api('POST', `/api/sign/alice/${env.id}/sign`, {
      json: {
        consent: true,
        blobOid: env.blobOid,
        values: [
          { field: 'f1', value: 'Alice' },
          { field: 'f4', value: 'x' },
        ],
      },
    })
    const { readFileSync, statSync } = await import('node:fs')
    const keyFile = join(root, 'data', 'sign', 'seal.json')
    expect(statSync(keyFile).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(keyFile, 'utf8')).certificateChainPem).toHaveLength(1)
  })
})

describe('removing an envelope', () => {
  it('moves it to the trash', async () => {
    const { env } = await draft()
    await api('DELETE', `/api/sign/alice/${env.id}`, { status: 204 })
    await api('GET', `/api/sign/alice/${env.id}`, { status: 404 })
    expect((await api('GET', '/api/sign')).envelopes).toEqual([])
  })
})
