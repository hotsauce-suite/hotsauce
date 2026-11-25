import { join } from 'node:path'
import { SAVED_SIGNATURE_PATH } from '@hotsauce/format'
import { getDocumentProxy } from 'unpdf'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { makeTestPdf } from '../../src/links/test-pdf.js'
import { FakeLLM, scriptedResponse } from '../../src/meetings/index.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

// Saved and uploaded signatures (docs/PLAN-sign-saved-signature.md) through the API with dev auth.

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

const FIELDS3 = [
  { id: 'f1', signer: 's1', type: 'signature', page: 1, x: 0.1, y: 0.7, width: 0.3, height: 0.06 },
  { id: 'f2', signer: 's1', type: 'initials', page: 2, x: 0.1, y: 0.2, width: 0.1, height: 0.04 },
]

async function ready(as = ALICE) {
  const made = await draft(as)
  const space = as.split('@')[0]
  const env = await api('PUT', `/api/sign/${space}/${made.env.id}`, {
    as,
    json: { title: 'Offer for Maya', fields: FIELDS3, blobOid: made.env.blobOid },
  })
  return { ...made, env, space }
}

describe('a member’s saved signature and initials (R5)', () => {
  it('starts empty, saves each kind, and keeps them in the personal space', async () => {
    expect(await api('GET', '/api/sign-saved')).toEqual({ signature: null, initials: null })
    await api('PUT', '/api/sign-saved/signature', { json: { input: 'uploaded', image: DRAWN } })
    const both = await api('PUT', '/api/sign-saved/initials', {
      json: { input: 'typed', value: '  A   L ' },
    })
    expect(both).toMatchObject({
      signature: { input: 'uploaded', image: DRAWN },
      initials: { input: 'typed', value: 'A L' },
    })
    expect(await api('GET', '/api/sign-saved')).toEqual(both)
    const file = await services.git.readFile('alice', SAVED_SIGNATURE_PATH)
    expect(JSON.parse(file.content)).toEqual(both)
  })

  it('keeps both when the signature and initials are saved at the same moment', async () => {
    await api('GET', '/api/sign-saved')
    await Promise.all([
      api('PUT', '/api/sign-saved/signature', { json: { input: 'drawn', image: DRAWN } }),
      api('PUT', '/api/sign-saved/initials', { json: { input: 'typed', value: 'AL' } }),
    ])
    const both = await api('GET', '/api/sign-saved')
    expect(both.signature).toMatchObject({ input: 'drawn' })
    expect(both.initials).toMatchObject({ value: 'AL' })
  })

  it('is private: another member sees only their own', async () => {
    await api('PUT', '/api/sign-saved/signature', { json: { input: 'drawn', image: DRAWN } })
    expect(await api('GET', '/api/sign-saved', { as: BOB })).toEqual({
      signature: null,
      initials: null,
    })
  })

  it('replaces and deletes', async () => {
    await api('PUT', '/api/sign-saved/signature', { json: { input: 'drawn', image: DRAWN } })
    await api('PUT', '/api/sign-saved/signature', { json: { input: 'typed', value: 'Alice' } })
    expect((await api('GET', '/api/sign-saved')).signature).toMatchObject({
      input: 'typed',
      value: 'Alice',
    })
    const after = await api('DELETE', '/api/sign-saved/signature')
    expect(after.signature).toBeNull()
  })

  it('refuses a picture that isn’t a PNG, one too big, and an empty typed one', async () => {
    await api('PUT', '/api/sign-saved/signature', {
      json: { input: 'uploaded', image: 'data:image/jpeg;base64,/9j/4AAQ' },
      status: 400,
    })
    const png = Buffer.from(DRAWN.split(',')[1] ?? '', 'base64')
    png.writeUInt32BE(30_000, 16)
    await api('PUT', '/api/sign-saved/signature', {
      json: { input: 'uploaded', image: `data:image/png;base64,${png.toString('base64')}` },
      status: 400,
    })
    await api('PUT', '/api/sign-saved/initials', {
      json: { input: 'typed', value: '   ' },
      status: 400,
    })
    await api('PUT', '/api/sign-saved/stamp', { json: { input: 'typed', value: 'x' }, status: 400 })
  })

  it('treats a hand-broken file as nothing saved, and saving mends it', async () => {
    await api('GET', '/api/sign-saved')
    await services.git.commit('alice', {
      changes: [{ path: SAVED_SIGNATURE_PATH, content: 'not json' }],
      author: { name: 'alice', email: ALICE },
      message: 'break it',
    })
    expect(await api('GET', '/api/sign-saved')).toEqual({ signature: null, initials: null })
    await api('PUT', '/api/sign-saved/initials', { json: { input: 'typed', value: 'AL' } })
    expect((await api('GET', '/api/sign-saved')).initials).toMatchObject({ value: 'AL' })
  })
})

describe('signing with an uploaded or saved signature (R3, R4)', () => {
  it('records an uploaded picture as uploaded and stamps it', async () => {
    const { env, space } = await ready()
    const done = await api('POST', `/api/sign/${space}/${env.id}/sign`, {
      json: {
        consent: true,
        blobOid: env.blobOid,
        values: [
          { field: 'f1', image: DRAWN, input: 'uploaded' },
          { field: 'f2', value: 'AL' },
        ],
      },
    })
    expect(done.status).toBe('completed')
    expect(done.fields[0]).toMatchObject({ input: 'uploaded', image: DRAWN })
    const signed = done.audit.find((a: { event: string }) => a.event === 'signed')
    expect(signed.meta.adoption).toEqual([
      { type: 'signature', input: 'uploaded', saved: false },
      { type: 'initials', input: 'typed', saved: false },
    ])
    expect(done.auditIntact).toBe(true)
    const cert = await services.files.bytes('team', done.result.certificateFile, 50_000_000)
    const text = await textOf(cert as Uint8Array)
    expect(text).toContain('signature: uploaded image')
    expect(text).toContain('initials: typed')
  })

  it('notes when the member reused their saved signature, checked on the server', async () => {
    await api('PUT', '/api/sign-saved/signature', { json: { input: 'uploaded', image: DRAWN } })
    await api('PUT', '/api/sign-saved/initials', { json: { input: 'typed', value: 'AL' } })
    const { env, space } = await ready()
    const done = await api('POST', `/api/sign/${space}/${env.id}/sign`, {
      json: {
        consent: true,
        blobOid: env.blobOid,
        values: [
          { field: 'f1', image: DRAWN, input: 'uploaded' },
          { field: 'f2', value: 'A.L.' },
        ],
      },
    })
    const signed = done.audit.find((a: { event: string }) => a.event === 'signed')
    // The initials differ from the saved ones, so only the signature counts as reused.
    expect(signed.meta.adoption).toEqual([
      { type: 'signature', input: 'uploaded', saved: true },
      { type: 'initials', input: 'typed', saved: false },
    ])
    const cert = await services.files.bytes('team', done.result.certificateFile, 50_000_000)
    expect(await textOf(cert as Uint8Array)).toContain(
      'signature: uploaded image, their saved signature',
    )
  })

  it('takes an uploaded picture from someone signing with an emailed link', async () => {
    const { env, space } = await ready()
    const sent = await api('PUT', `/api/sign/${space}/${env.id}`, {
      json: {
        title: 'Offer for Maya',
        signers: [{ id: 's1', name: 'Maya', email: 'maya@outside.test', order: 1 }],
        fields: FIELDS3,
        blobOid: env.blobOid,
      },
    })
    const out = await api('POST', `/api/sign/${space}/${env.id}/send`, {
      json: { blobOid: sent.blobOid },
    })
    const token = out.links[0].url.split('/signing/')[1]
    const done = await api('POST', `/api/sign-link/${token}/sign`, {
      json: {
        consent: true,
        values: [
          { field: 'f1', image: DRAWN, input: 'uploaded' },
          { field: 'f2', value: 'ML' },
        ],
      },
    })
    expect(done.status).toBe('completed')
    const view = await api('GET', `/api/sign/${space}/${env.id}`)
    expect(view.fields[0]).toMatchObject({ input: 'uploaded' })
    const signed = view.audit.find((a: { event: string }) => a.event === 'signed')
    expect(signed.meta.adoption[0]).toEqual({ type: 'signature', input: 'uploaded', saved: false })
  })

  it('calls an image with no input drawn, as before', async () => {
    const { env, space } = await ready()
    const done = await api('POST', `/api/sign/${space}/${env.id}/sign`, {
      json: {
        consent: true,
        blobOid: env.blobOid,
        values: [
          { field: 'f1', image: DRAWN },
          { field: 'f2', image: DRAWN, input: 'typed' },
        ],
      },
    })
    expect(done.fields.map((f: { input: string }) => f.input)).toEqual(['drawn', 'drawn'])
  })
})
