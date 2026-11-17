import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { makeTestPdf } from '../../src/links/test-pdf.js'
import { FakeMailer } from '../../src/mail/index.js'
import { FakeLLM, scriptedResponse } from '../../src/meetings/index.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

// Sign, slice 3 (docs/PLAN-sign.md R10–R17): the sender lists people, sends, and people outside the
// team sign or decline from their emailed link with no account. Email goes to a fake mailer.

const ALICE = 'alice@example.test'
// A 1×1 PNG, standing in for a drawn signature.
const DRAWN =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

let root: string
let services: Services
let mailer: FakeMailer
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
  mailer = new FakeMailer()
  services = createServices(config, { llm: new FakeLLM(scriptedResponse), mailer })
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

const MAYA = 'maya@outside.example.org'
const RAJ = 'raj@outside.example.org'

const PEOPLE = [
  { id: 's1', name: 'Alice Archer', email: ALICE, order: 1, role: 'signer' },
  { id: 's2', name: 'Maya Lin', email: MAYA, order: 2, role: 'signer' },
  { id: 's3', name: 'Raj Patel', email: RAJ, order: 3, role: 'copy' },
]
const sig = (id: string, signer: string, page = 1, y = 0.7) => ({
  id,
  signer,
  type: 'signature',
  page,
  x: 0.1,
  y,
  width: 0.3,
  height: 0.06,
})

async function ready(order: 'parallel' | 'sequential' = 'parallel', people = PEOPLE) {
  const made = await draft()
  const fields = people
    .filter((p) => p.role === 'signer')
    .map((p, i) => sig(`f${i + 1}`, p.id, 1, 0.1 + i * 0.1))
  return api('PUT', `/api/sign/alice/${made.env.id}`, {
    json: {
      title: 'Pilot agreement',
      fields,
      signers: people,
      signingOrder: order,
      blobOid: made.env.blobOid,
    },
  })
}

const tokenOf = (url: string) => url.slice(url.indexOf('/s/') + 3)

// biome-ignore lint/suspicious/noExplicitAny: test responses are read loosely
async function publicApi<T = any>(
  method: string,
  path: string,
  json?: unknown,
  status = 200,
): Promise<T> {
  const res = await app.request(path, {
    method,
    headers: json === undefined ? {} : { 'content-type': 'application/json' },
    ...(json === undefined ? {} : { body: JSON.stringify(json) }),
  })
  const text = await res.text()
  expect(res.status, `${method} ${path} → ${text}`).toBe(status)
  return (text ? JSON.parse(text) : null) as T
}

describe('the people on an envelope (R10)', () => {
  it('saves signers, copies and the order, and refuses fields for a copy', async () => {
    const env = await ready('sequential')
    expect(env.signing_order ?? env.signerList.length).toBeTruthy()
    expect(env.signerList.map((s: { role: string }) => s.role)).toEqual([
      'signer',
      'signer',
      'copy',
    ])
    const res = await api('PUT', `/api/sign/alice/${env.id}`, {
      json: { title: 'x', fields: [sig('f1', 's1'), sig('f2', 's3')], blobOid: env.blobOid },
      status: 400,
    })
    expect(res.error.message).toMatch(/only gets a copy/)
  })

  it('won’t let the sender sign alone before sending when others sign too', async () => {
    const env = await ready()
    expect(env.canSign).toBe(false)
  })
})

describe('sending and signing from a link (R11–R16)', () => {
  it('emails each signer their own link, all at once, and shows the links once', async () => {
    const env = await ready()
    const sent = await api('POST', `/api/sign/alice/${env.id}/send`, {
      json: { blobOid: env.blobOid },
    })
    expect(sent.status).toBe('sent')
    // The sender signs in the app, so only Maya gets a link; Raj only gets the copy at the end.
    expect(sent.links.map((l: { email: string }) => l.email)).toEqual([MAYA])
    expect(sent.links[0].emailed).toBe(true)
    expect(sent.links[0].url).toMatch(
      /^https:\/\/hotsauce\.example\.test\/s\/[0-9A-Z]{26}\.s2\.[\w-]{43}$/,
    )
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0]).toMatchObject({
      to: MAYA,
      fromName: 'Alice Archer via Fieldwork',
      replyTo: ALICE,
    })
    expect(mailer.sent[0]?.text).toContain(sent.links[0].url)
    // Only the hash is kept, in Git and in what the sender sees.
    const file = await services.git.readFile('alice', `sign/${env.id}.md`)
    const secret = tokenOf(sent.links[0].url).split('.')[2] ?? ''
    expect(file.content).not.toContain(secret)
    expect(JSON.stringify(sent.signerList)).not.toContain('token_hash')
    expect(sent.signerList[1].linkActive).toBe(true)
  })

  it('lets Maya sign from her link while Alice signs in the app, then everyone gets the copies', async () => {
    const env = await ready()
    const sent = await api('POST', `/api/sign/alice/${env.id}/send`, {
      json: { blobOid: env.blobOid },
    })
    const token = tokenOf(sent.links[0].url)

    const view = await publicApi('GET', `/api/sign-link/${token}`)
    expect(view).toMatchObject({
      title: 'Pilot agreement',
      sender: 'Alice Archer',
      org: 'Fieldwork',
      status: 'ready',
    })
    expect(view.signer).toEqual({ id: 's2', name: 'Maya Lin', email: MAYA })
    expect(view.fields.map((f: { id: string }) => f.id)).toEqual(['f2'])
    const pdf = await app.request(`/api/sign-link/${token}/source.pdf`)
    expect(pdf.status).toBe(200)
    expect(pdf.headers.get('content-type')).toBe('application/pdf')

    const signed = await publicApi('POST', `/api/sign-link/${token}/sign`, {
      consent: true,
      values: [{ field: 'f2', value: 'Maya Lin' }],
    })
    expect(signed.status).toBe('signed')
    mailer.sent.length = 0

    const mid = await api('GET', `/api/sign/alice/${env.id}`)
    const done = await api('POST', `/api/sign/alice/${env.id}/sign`, {
      json: {
        consent: true,
        blobOid: mid.blobOid,
        values: [{ field: 'f1', value: 'Alice Archer' }],
      },
    })
    expect(done.status).toBe('completed')
    expect(done.auditIntact).toBe(true)
    const events = done.audit.map((a: { event: string }) => a.event)
    expect(events).toEqual([
      'created',
      'sent',
      'viewed',
      'consented',
      'signed',
      'consented',
      'signed',
      'completed',
    ])
    expect(done.audit[4].meta.method).toBe('Email link')
    expect(done.audit[6].meta.method).toBe('Signed in to Hotsauce')
    // Everyone on it, the copy included, gets both PDFs attached.
    expect(mailer.sent.map((m) => m.to).sort()).toEqual([ALICE, MAYA, RAJ].sort())
    for (const m of mailer.sent) {
      expect(m.attachments?.map((a) => a.filename)).toEqual([
        'offer (signed).pdf',
        'offer (certificate).pdf',
      ])
    }
    // Her link now shows what happened, and can't sign again.
    expect((await publicApi('GET', `/api/sign-link/${token}`)).status).toBe('completed')
    await publicApi('POST', `/api/sign-link/${token}/sign`, { consent: true, values: [] }, 409)
  })

  it('in order, the next person gets their link only when the one before signs (R13)', async () => {
    const people = [
      { id: 's1', name: 'Maya Lin', email: MAYA, order: 1, role: 'signer' },
      { id: 's2', name: 'Raj Patel', email: RAJ, order: 2, role: 'signer' },
    ]
    const env = await ready('sequential', people)
    const sent = await api('POST', `/api/sign/alice/${env.id}/send`, {
      json: { blobOid: env.blobOid },
    })
    expect(sent.links.map((l: { email: string }) => l.email)).toEqual([MAYA])
    expect(sent.upNext).toEqual(['s1'])
    await api('POST', `/api/sign/alice/${env.id}/link/s2`, { json: { email: false }, status: 409 })

    await publicApi('POST', `/api/sign-link/${tokenOf(sent.links[0].url)}/sign`, {
      consent: true,
      values: [{ field: 'f1', value: 'Maya Lin' }],
    })
    expect(mailer.sent.map((m) => m.to)).toEqual([MAYA, RAJ])
    const rajUrl = /https:\S+/.exec(mailer.sent[1]?.text ?? '')?.[0] ?? ''
    const done = await publicApi('POST', `/api/sign-link/${tokenOf(rajUrl)}/sign`, {
      consent: true,
      values: [{ field: 'f2', image: DRAWN }],
    })
    expect(done.status).toBe('completed')
    // The sender isn't a signer here, and still gets the copies.
    expect(
      mailer.sent
        .slice(2)
        .map((m) => m.to)
        .sort(),
    ).toEqual([ALICE, MAYA, RAJ].sort())
  })

  it('declining stops the envelope and tells the sender (R16)', async () => {
    const env = await ready()
    const sent = await api('POST', `/api/sign/alice/${env.id}/send`, {
      json: { blobOid: env.blobOid },
    })
    const token = tokenOf(sent.links[0].url)
    const out = await publicApi('POST', `/api/sign-link/${token}/decline`, {
      reason: '  Wrong   start date ',
    })
    expect(out.status).toBe('declined')
    const after = await api('GET', `/api/sign/alice/${env.id}`)
    expect(after.status).toBe('declined')
    expect(after.signerList[1]).toMatchObject({
      status: 'declined',
      decline_reason: 'Wrong start date',
    })
    expect(after.audit.at(-1)).toMatchObject({ event: 'declined', email: MAYA })
    expect(mailer.sent.at(-1)).toMatchObject({ to: ALICE, subject: 'Declined: “Pilot agreement”' })
    expect(mailer.sent.at(-1)?.text).toContain('Wrong start date')
    await api('POST', `/api/sign/alice/${env.id}/sign`, {
      json: { consent: true, blobOid: after.blobOid, values: [{ field: 'f1', value: 'A' }] },
      status: 409,
    })
  })

  it('a fresh link stops the old one; a wrong or expired link says so plainly (R11, R14)', async () => {
    const env = await ready()
    const sent = await api('POST', `/api/sign/alice/${env.id}/send`, {
      json: { blobOid: env.blobOid },
    })
    const old = tokenOf(sent.links[0].url)
    const fresh = await api('POST', `/api/sign/alice/${env.id}/link/s2`, { json: { email: false } })
    expect(fresh.emailed).toBe(false)
    expect(mailer.sent).toHaveLength(1)
    const gone = await publicApi('GET', `/api/sign-link/${old}`, undefined, 404)
    expect(gone.error.message).toMatch(/doesn’t work/)
    await publicApi('GET', `/api/sign-link/${tokenOf(fresh.url)}`)
    await publicApi('GET', `/api/sign-link/${old.slice(0, -3)}xyz`, undefined, 404)
    await publicApi('GET', '/api/sign-link/nonsense', undefined, 404)
    await publicApi('POST', `/api/sign-link/${old}/sign`, { consent: true, values: [] }, 404)

    // 31 days later the link has expired.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 31 * 86_400_000)
    try {
      const gone = await publicApi('GET', `/api/sign-link/${tokenOf(fresh.url)}`, undefined, 409)
      expect(gone.error.message).toMatch(/expired/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('without email on the server, Send gives the links to copy', async () => {
    const env = await ready()
    ;(mailer as unknown as { available: boolean }).available = false
    const sent = await api('POST', `/api/sign/alice/${env.id}/send`, {
      json: { blobOid: env.blobOid },
    })
    expect(sent.canEmail).toBe(false)
    expect(sent.links[0]).toMatchObject({ email: MAYA, emailed: false })
    expect(mailer.sent).toHaveLength(0)
  })
})
