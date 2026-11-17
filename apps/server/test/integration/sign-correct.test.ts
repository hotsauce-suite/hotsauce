import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { makeTestPdf } from '../../src/links/test-pdf.js'
import { FakeMailer } from '../../src/mail/index.js'
import { FakeLLM, scriptedResponse } from '../../src/meetings/index.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

// Sign, slice 3b (docs/PLAN-sign.md R19–R24): the sender corrects someone on an envelope after
// sending, and anyone who can open a sent envelope copies it into a new draft.

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'
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
  // Emails go out after the response.
  await services.sign.settled()
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

const tokenOf = (url: string) => url.slice(url.indexOf('/signing/') + 9)

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
  await services.sign.settled()
  return (text ? JSON.parse(text) : null) as T
}

const MAYA_RIGHT = 'maya.lin@outside.example.org'

async function sendReady(order: 'parallel' | 'sequential' = 'parallel', people = PEOPLE) {
  const env = await ready(order, people)
  return api('POST', `/api/sign/alice/${env.id}/send`, { json: { blobOid: env.blobOid } })
}

const correct = (
  id: string,
  signer: string,
  json: unknown,
  opts: { as?: string; status?: number } = {},
) => api('PATCH', `/api/sign/alice/${id}/people/${signer}`, { json, ...opts })

describe('correcting someone after sending (R19–R23)', () => {
  it('stops the old link, emails a fresh one to the new address and audits the change', async () => {
    const sent = await sendReady()
    const old = tokenOf(sent.links[0].url)
    // Maya opened it from the wrong address's link before the sender noticed.
    await publicApi('GET', `/api/sign-link/${old}`)
    mailer.sent.length = 0

    const fixed = await correct(sent.id, 's2', { email: MAYA_RIGHT })
    expect(fixed.link).toMatchObject({ signer: 's2', email: MAYA_RIGHT, emailed: true })
    expect(mailer.sent.map((m) => m.to)).toEqual([MAYA_RIGHT])
    expect(mailer.sent[0]?.text).toContain(fixed.link.url)
    expect(fixed.signerList[1]).toMatchObject({
      email: MAYA_RIGHT,
      name: 'Maya Lin',
      linkActive: true,
    })
    // The earlier open was the old address's: the new person's first open is recorded.
    expect(fixed.signerList[1].viewed_at).toBeUndefined()
    expect(fixed.audit.at(-1)).toMatchObject({
      event: 'signer_corrected',
      actor: 'sender',
      email: ALICE,
      meta: {
        signerId: 's2',
        previousEmail: MAYA,
        previousName: 'Maya Lin',
        signerEmail: MAYA_RIGHT,
        signerName: 'Maya Lin',
        emailed: true,
      },
    })
    expect(fixed.auditIntact).toBe(true)

    await publicApi('GET', `/api/sign-link/${old}`, undefined, 404)
    const fresh = tokenOf(fixed.link.url)
    const view = await publicApi('GET', `/api/sign-link/${fresh}`)
    expect(view.signer).toEqual({ id: 's2', name: 'Maya Lin', email: MAYA_RIGHT })
    const after = await api('GET', `/api/sign/alice/${sent.id}`)
    expect(after.audit.at(-1)).toMatchObject({ event: 'viewed', email: MAYA_RIGHT })

    // She signs, Alice signs, and the sealed copies go to the corrected address, not the old one.
    await publicApi('POST', `/api/sign-link/${fresh}/sign`, {
      consent: true,
      values: [{ field: 'f2', value: 'Maya Lin' }],
    })
    mailer.sent.length = 0
    const mid = await api('GET', `/api/sign/alice/${sent.id}`)
    const done = await api('POST', `/api/sign/alice/${sent.id}/sign`, {
      json: {
        consent: true,
        blobOid: mid.blobOid,
        values: [{ field: 'f1', value: 'Alice Archer' }],
      },
    })
    expect(done.status).toBe('completed')
    expect(done.auditIntact).toBe(true)
    expect(mailer.sent.map((m) => m.to).sort()).toEqual([ALICE, MAYA_RIGHT, RAJ].sort())
  })

  it('without email on the server, gives the new link to copy', async () => {
    const sent = await sendReady()
    ;(mailer as unknown as { available: boolean }).available = false
    const fixed = await correct(sent.id, 's2', { name: 'Maya Lin-Park', email: MAYA_RIGHT })
    expect(fixed.link).toMatchObject({ email: MAYA_RIGHT, name: 'Maya Lin-Park', emailed: false })
    expect(fixed.audit.at(-1).meta).toMatchObject({ emailed: false, signerName: 'Maya Lin-Park' })
    await publicApi('GET', `/api/sign-link/${tokenOf(fixed.link.url)}`)
  })

  it('a failed email changes nothing: the old link still works and nothing is audited (R22)', async () => {
    const sent = await sendReady()
    const before = await api('GET', `/api/sign/alice/${sent.id}`)
    mailer.send = async () => {
      throw new Error('Resend is down')
    }
    const res = await correct(sent.id, 's2', { email: MAYA_RIGHT }, { status: 502 })
    expect(res.error.message).toMatch(/couldn’t be emailed/)
    const after = await api('GET', `/api/sign/alice/${sent.id}`)
    expect(after.blobOid).toBe(before.blobOid)
    expect(after.signerList[1].email).toBe(MAYA)
    await publicApi('GET', `/api/sign-link/${tokenOf(sent.links[0].url)}`)
  })

  it('someone not yet up gets no link until their turn; a name-only fix makes a fresh link', async () => {
    const people = [
      { id: 's1', name: 'Maya Lin', email: MAYA, order: 1, role: 'signer' },
      { id: 's2', name: 'Raj Patel', email: RAJ, order: 2, role: 'signer' },
    ]
    const sent = await sendReady('sequential', people)
    mailer.sent.length = 0
    const later = await correct(sent.id, 's2', { email: 'raj.p@outside.example.org' })
    expect(later.link).toBeNull()
    expect(mailer.sent).toHaveLength(0)
    expect(later.signerList[1]).toMatchObject({
      email: 'raj.p@outside.example.org',
      linkActive: false,
    })

    // A name-only fix still stops the old link: links are per person, and the record changed.
    const renamed = await correct(sent.id, 's1', { name: 'Maya J. Lin' })
    expect(renamed.link).toMatchObject({ name: 'Maya J. Lin', email: MAYA })
    await publicApi('GET', `/api/sign-link/${tokenOf(sent.links[0].url)}`, undefined, 404)

    // When Maya signs, Raj's corrected address gets his link.
    mailer.sent.length = 0
    await publicApi('POST', `/api/sign-link/${tokenOf(renamed.link.url)}/sign`, {
      consent: true,
      values: [{ field: 'f1', value: 'Maya J. Lin' }],
    })
    expect(mailer.sent.map((m) => m.to)).toEqual(['raj.p@outside.example.org'])
  })

  it('a copy recipient can be corrected and never gets a link', async () => {
    const sent = await sendReady()
    const fixed = await correct(sent.id, 's3', { email: 'raj.p@outside.example.org' })
    expect(fixed.link).toBeNull()
    expect(fixed.signerList[2]).toMatchObject({ role: 'copy', email: 'raj.p@outside.example.org' })
  })

  it('refuses what it can’t do (R19, R20)', async () => {
    const sent = await sendReady()
    // Someone already on it.
    const dup = await correct(sent.id, 's2', { email: RAJ.toUpperCase() }, { status: 400 })
    expect(dup.error.message).toMatch(/already on this envelope/)
    // No such person, and a bad address.
    await correct(sent.id, 's9', { email: MAYA_RIGHT }, { status: 404 })
    await correct(sent.id, 's2', { email: 'not an email' }, { status: 400 })
    // Nothing to change does nothing.
    const same = await correct(sent.id, 's2', { email: MAYA, name: 'Maya Lin' })
    expect(same.link).toBeNull()
    expect(same.audit.at(-1).event).not.toBe('signer_corrected')
    // Someone who signed can't be corrected.
    await publicApi('POST', `/api/sign-link/${tokenOf(sent.links[0].url)}/sign`, {
      consent: true,
      values: [{ field: 'f2', value: 'Maya Lin' }],
    })
    const signed = await correct(sent.id, 's2', { email: MAYA_RIGHT }, { status: 409 })
    expect(signed.error.message).toMatch(/already signed/)
    // A draft is edited, not corrected.
    const draftOnly = await ready()
    await correct(draftOnly.id, 's2', { email: MAYA_RIGHT }, { status: 409 })
  })

  it('only the sender can correct, even on a shared envelope (R19)', async () => {
    const file = await upload('offer.pdf', offer())
    const made = await api('POST', '/api/sign', {
      json: { fileSpace: 'team', fileId: file.id, space: 'team' },
    })
    const env = await api('PUT', `/api/sign/team/${made.id}`, {
      json: {
        title: 'Team NDA',
        fields: [sig('f1', 's2')],
        signers: [{ ...PEOPLE[1], order: 1 }],
        blobOid: made.blobOid,
      },
    })
    await api('POST', `/api/sign/team/${env.id}/send`, { json: { blobOid: env.blobOid } })
    const res = await api('PATCH', `/api/sign/team/${env.id}/people/s2`, {
      as: BOB,
      json: { email: MAYA_RIGHT },
      status: 403,
    })
    expect(res.error.message).toMatch(/Only the person who made this envelope/)
    const after = await api('GET', `/api/sign/team/${env.id}`, { as: BOB })
    expect(after.signerList[0].email).toBe(MAYA)
  })

  it('correcting someone to the sender’s own address lets them sign in the app, with no link', async () => {
    const people = [{ id: 's1', name: 'Maya Lin', email: MAYA, order: 1, role: 'signer' }]
    const sent = await sendReady('parallel', people)
    const fixed = await correct(sent.id, 's1', { name: 'Alice Archer', email: ALICE })
    expect(fixed.link).toBeNull()
    expect(fixed.canSign).toBe(true)
    await publicApi('GET', `/api/sign-link/${tokenOf(sent.links[0].url)}`, undefined, 404)
  })
})

describe('copying an envelope into a new draft (R24)', () => {
  it('copies the PDF, people, order and field places, with nothing filled in', async () => {
    const sent = await sendReady()
    await publicApi('POST', `/api/sign-link/${tokenOf(sent.links[0].url)}/decline`, {
      reason: 'Wrong date',
    })
    const original = await api('GET', `/api/sign/alice/${sent.id}`)
    mailer.sent.length = 0

    const copy = await api('POST', `/api/sign/alice/${sent.id}/copy`)
    expect(copy.id).not.toBe(sent.id)
    expect(copy.space).toBe('alice')
    expect(copy.status).toBe('draft')
    expect(copy.title).toBe('Pilot agreement')
    expect(copy.signingOrder).toBe('parallel')
    expect(copy.source).toEqual(original.source)
    expect(copy.signerList).toEqual(
      PEOPLE.map((p) => ({ ...p, status: 'pending', linkActive: false })),
    )
    expect(copy.fields.map((f: { id: string }) => f.id)).toEqual(['f1', 'f2'])
    for (const f of copy.fields) {
      expect(f.value ?? f.filled_at ?? f.image ?? f.checked).toBeUndefined()
    }
    expect(copy.createdBy).toBe(ALICE)
    expect(copy.audit.map((a: { event: string }) => a.event)).toEqual(['copied'])
    expect(copy.audit[0].meta).toMatchObject({ from: sent.id, file: 'offer.pdf' })
    expect(copy.auditIntact).toBe(true)
    expect(mailer.sent).toHaveLength(0)
    // The original is left as it is.
    expect((await api('GET', `/api/sign/alice/${sent.id}`)).blobOid).toBe(original.blobOid)
    // The copy can be sent like any draft.
    const resent = await api('POST', `/api/sign/alice/${copy.id}/send`, {
      json: { blobOid: copy.blobOid },
    })
    expect(resent.status).toBe('sent')
  })

  it('whoever copies a shared envelope becomes the copy’s sender', async () => {
    const file = await upload('offer.pdf', offer())
    const made = await api('POST', '/api/sign', {
      json: { fileSpace: 'team', fileId: file.id, space: 'team' },
    })
    const env = await api('PUT', `/api/sign/team/${made.id}`, {
      json: {
        title: 'Team NDA',
        fields: [sig('f1', 's2')],
        signers: [{ ...PEOPLE[1], order: 1 }],
        blobOid: made.blobOid,
      },
    })
    await api('POST', `/api/sign/team/${env.id}/send`, { json: { blobOid: env.blobOid } })
    const copy = await api('POST', `/api/sign/team/${env.id}/copy`, { as: BOB })
    expect(copy.space).toBe('team')
    expect(copy.createdBy).toBe(BOB)
    expect(copy.audit[0]).toMatchObject({ event: 'copied', email: BOB })
  })

  it('refuses a draft, and a PDF that left Files', async () => {
    const made = await draft()
    await api('POST', `/api/sign/alice/${made.env.id}/copy`, { status: 409 })

    const sent = await sendReady()
    const env = await api('GET', `/api/sign/alice/${sent.id}`)
    await api('DELETE', `/api/files/item/${env.source.space}/${env.source.file}`, { status: 204 })
    const res = await api('POST', `/api/sign/alice/${sent.id}/copy`, { status: 404 })
    expect(res.error.message).toMatch(/gone from Files/)
  })
})
