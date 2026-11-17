// MSW routes for Sign (`/api/sign`; docs/PLAN-sign.md), in memory and shaped like the server's
// (apps/server/src/sign). The demo can't seal a PDF in the browser: its "signed" copy is the
// original, and its certificate a plain page listing the audit trail. The real server stamps the
// fields and seals both with @hotsauce/sign.

import {
  type AuditEntry,
  EnvelopeFrontmatter,
  envelopeProblem,
  newId,
  type Signer,
  type SignField,
  signersUpNext,
} from '@hotsauce/format'
import { type AnyHandler, delay, HttpResponse, http } from 'msw'
import type {
  EnvelopeSummary,
  EnvelopeView,
  FilledValue,
  PublicEnvelope,
  SigningLink,
} from '../api/sign'
import type { FakeUser } from './fakeRepo'
import type { FakeFiles } from './fileHandlers'
import { textPdf } from './fileSeed'
import { ADA, seedId } from './seed'

const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const error = (status: number, code: string, message: string) =>
  HttpResponse.json({ error: { code, message } }, { status })
const fakeHash = (seed: string) =>
  Array.from(seed.padEnd(64, '0').slice(0, 64), (c) => (c.charCodeAt(0) % 16).toString(16)).join('')

interface Stored {
  space: string
  fm: EnvelopeFrontmatter
  blobOid: string
}

export class FakeSign {
  readonly envelopes = new Map<string, Stored>()
  /** Signing links still working: token → the envelope's key and the signer's id. */
  readonly links = new Map<string, { key: string; signer: string }>()

  key(space: string, id: string) {
    return `${space}/${id}`
  }

  /** Appends audit events with a stand-in chain (the demo doesn't hash). */
  audit(
    fm: EnvelopeFrontmatter,
    events: Array<Pick<AuditEntry, 'event' | 'actor' | 'email' | 'at'>>,
  ): AuditEntry[] {
    const out = [...fm.audit]
    for (const e of events) {
      const prev = out.at(-1)?.hash ?? null
      out.push({
        seq: out.length + 1,
        id: newId(),
        ip: null,
        agent: null,
        meta: null,
        prev,
        hash: fakeHash(`${fm.id}${out.length}${e.event}`),
        ...e,
      })
    }
    return out
  }
}

function summary(s: Stored): EnvelopeSummary {
  const { fm } = s
  return {
    space: s.space,
    id: fm.id,
    title: fm.title,
    status: fm.status,
    sourceName: fm.source.name,
    signers: fm.signers.map(({ name, email, status }) => ({ name, email, status })),
    created: fm.created,
    createdBy: fm.created_by,
    updated: fm.updated ?? null,
    completed: fm.completed ?? null,
  }
}

function view(s: Stored, me: string): EnvelopeView {
  const { fm } = s
  const mine = fm.signers.find((x) => x.email === me.toLowerCase() && x.role !== 'copy')
  const next = fm.status === 'sent' ? signersUpNext(fm.signers, fm.signing_order) : []
  return {
    ...summary(s),
    source: fm.source,
    signerList: fm.signers.map(({ token_hash, ...x }) => ({
      ...x,
      linkActive: Boolean(token_hash) && x.status === 'pending',
    })),
    fields: fm.fields,
    audit: fm.audit,
    auditIntact: true,
    result: fm.result
      ? {
          space: fm.source.space,
          signedFile: fm.result.signed_file,
          certificateFile: fm.result.certificate_file,
        }
      : null,
    canSign:
      mine?.status === 'pending' &&
      envelopeProblem(fm) === null &&
      (fm.status === 'draft'
        ? !fm.signers.some((x) => x.role !== 'copy' && x.id !== mine.id)
        : next.some((x) => x.id === mine.id)),
    // The demo sends no email: Send shows each link to copy, as a server without email does.
    canEmail: false,
    upNext: next.map((x) => x.id),
    signingOrder: fm.signing_order,
    blobOid: s.blobOid,
  }
}

const secret = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.charAt(b % 64),
  ).join('')

/** New links for whoever is up to sign now, except `skip` (the member, who signs in the app). */
function issueLinks(fake: FakeSign, s: Stored, skip: string | null): SigningLink[] {
  const key = fake.key(s.space, s.fm.id)
  const out: SigningLink[] = []
  const now = iso(Date.now())
  const up = new Set(signersUpNext(s.fm.signers, s.fm.signing_order).map((x) => x.id))
  s.fm = {
    ...s.fm,
    signers: s.fm.signers.map((x): Signer => {
      if (!up.has(x.id) || x.email === skip || x.token_hash) return x
      out.push(makeLink(fake, key, s.fm.id, x))
      return { ...x, token_hash: fakeHash(x.id + now), sent_at: now }
    }),
  }
  return out
}

function makeLink(fake: FakeSign, key: string, id: string, x: Signer): SigningLink {
  for (const [t, v] of fake.links) if (v.key === key && v.signer === x.id) fake.links.delete(t)
  const token = `${id}.${x.id}.${secret()}`
  fake.links.set(token, { key, signer: x.id })
  return {
    signer: x.id,
    name: x.name,
    email: x.email,
    url: `${location.origin}/signing/${token}`,
    emailed: false,
  }
}

/** Fills one signer's fields, chains the audit, and finishes the envelope when nobody is left. */
function signAs(
  fake: FakeSign,
  files: FakeFiles,
  s: Stored,
  signer: Signer,
  values: FilledValue[],
  method: string,
): void {
  const now = iso(Date.now())
  const byId = new Map(values.map((v) => [v.field, v]))
  const fields = s.fm.fields.map((f): SignField => {
    if (f.signer !== signer.id) return f
    const v = byId.get(f.id)
    if (f.type === 'checkbox') return { ...f, checked: v?.checked === true, filled_at: now }
    if (f.type === 'date') return { ...f, value: now.slice(0, 10), filled_at: now }
    if (v?.image) return { ...f, input: 'drawn', image: v.image, filled_at: now }
    return v?.value ? { ...f, input: 'typed', value: v.value, filled_at: now } : f
  })
  const signers = s.fm.signers.map(
    (x): Signer => (x.id === signer.id ? { ...x, status: 'signed', signed_at: now } : x),
  )
  const done = !signers.some((x) => x.role !== 'copy' && x.status === 'pending')
  let fm: EnvelopeFrontmatter = {
    ...s.fm,
    fields,
    signers,
    updated: now,
    ...(done ? { status: 'completed' as const, completed: now } : {}),
  }
  fm = {
    ...fm,
    audit: fake.audit(fm, [
      { event: 'consented', actor: 'signer', email: signer.email, at: now },
      { event: 'signed', actor: 'signer', email: signer.email, at: now },
      ...(done
        ? [{ event: 'completed' as const, actor: 'system' as const, email: null, at: now }]
        : []),
    ]),
  }
  fm.audit[fm.audit.length - (done ? 2 : 1)] = {
    ...(fm.audit[fm.audit.length - (done ? 2 : 1)] as (typeof fm.audit)[number]),
    meta: { method },
  }
  s.fm = done ? { ...fm, result: finish(files, fm, signer.email) } : fm
  s.blobOid = newId().toLowerCase()
  if (!done) issueLinks(fake, s, null)
}

/** Saves the "signed" copy and a certificate into Files beside the original. */
function finish(files: FakeFiles, fm: EnvelopeFrontmatter, by: string, at?: number) {
  const original = files.get(fm.source.space, fm.source.file)
  if (!original) throw new Error('The PDF is gone from Files')
  const stem = fm.source.name.replace(/\.pdf$/i, '')
  const signed = files.add({
    space: fm.source.space,
    folder: original.folder,
    name: `${stem} (signed).pdf`,
    bytes: original.bytes,
    by,
    ...(at ? { at } : {}),
  })
  const lines = [
    `Document: ${fm.source.name}`,
    ...fm.signers.map((s) => `Signer: ${s.name} <${s.email}>, ${s.status}`),
    '',
    ...fm.audit.map((a) => `${a.at}  ${a.event}${a.email ? ` by ${a.email}` : ''}`),
    '',
    'In the demo this page stands in for the sealed certificate.',
  ]
  const certificate = files.add({
    space: fm.source.space,
    folder: original.folder,
    name: `${stem} (certificate).pdf`,
    bytes: textPdf(`Certificate of Completion: ${fm.title}`, lines),
    by,
    ...(at ? { at } : {}),
  })
  return { signed_file: signed.id, certificate_file: certificate.id, signed_sha256: signed.sha256 }
}

/** The seeded envelope's signing link for Maya, at `/signing/<this>` in the demo. */
export const demoSigningToken = () => `${seedId('SG', 2)}.s2.${'demo'.repeat(8)}`

/** One signed envelope, made from the team's pilot one-pager, so the demo's Sign isn't empty. */
export function seedSign(fake: FakeSign, files: FakeFiles, now = Date.now()): void {
  const source = [...files.files.values()].find((f) => f.name === 'Acme pilot one-pager.pdf')
  if (!source) return
  const at = (days: number) => iso(now - days * DAY)
  const id = seedId('SG', 1)
  let fm = EnvelopeFrontmatter.parse({
    id,
    type: 'envelope',
    title: 'Acme pilot one-pager, approved',
    status: 'completed',
    source: {
      file: source.id,
      space: source.space,
      name: source.name,
      sha256: source.sha256,
      size: source.bytes.length,
      pages: [{ width: 612, height: 792 }],
    },
    signers: [
      {
        id: 's1',
        name: ADA.name,
        email: ADA.email,
        order: 1,
        status: 'signed',
        signed_at: at(2),
      },
    ],
    fields: [
      {
        id: 'f1',
        signer: 's1',
        type: 'signature',
        page: 1,
        x: 0.12,
        y: 0.78,
        width: 0.3,
        height: 0.06,
        input: 'typed',
        value: ADA.name,
        filled_at: at(2),
      },
    ],
    audit: [],
    created: at(2.1),
    created_by: ADA.email,
    updated: at(2),
    completed: at(2),
  })
  fm = {
    ...fm,
    audit: fake.audit(fm, [
      { event: 'created', actor: 'sender', email: ADA.email, at: at(2.1) },
      { event: 'consented', actor: 'signer', email: ADA.email, at: at(2) },
      { event: 'signed', actor: 'signer', email: ADA.email, at: at(2) },
      { event: 'completed', actor: 'system', email: null, at: at(2) },
    ]),
  }
  fm = { ...fm, result: finish(files, fm, ADA.email, now - 2 * DAY) }
  fake.envelopes.set(fake.key('ada', id), { space: 'ada', fm, blobOid: newId().toLowerCase() })

  // One out for signature: Ada has signed, and someone outside the team has opened their link.
  const out = seedId('SG', 2)
  let sent = EnvelopeFrontmatter.parse({
    id: out,
    type: 'envelope',
    title: 'Northwind pilot terms',
    status: 'sent',
    signing_order: 'parallel',
    source: fm.source,
    signers: [
      {
        id: 's1',
        name: ADA.name,
        email: ADA.email,
        order: 1,
        status: 'signed',
        signed_at: at(0.9),
      },
      {
        id: 's2',
        name: 'Maya Lin',
        email: 'maya@northwind.example',
        order: 2,
        status: 'pending',
        token_hash: fakeHash('seed-s2'),
        token_expires: at(-29),
        sent_at: at(1),
        viewed_at: at(0.5),
      },
      { id: 's3', name: 'Sam Ortiz', email: 'sam@northwind.example', order: 3, role: 'copy' },
    ],
    fields: [
      {
        id: 'f1',
        signer: 's1',
        type: 'signature',
        page: 1,
        x: 0.12,
        y: 0.78,
        width: 0.3,
        height: 0.06,
        input: 'typed',
        value: ADA.name,
        filled_at: at(0.9),
      },
      {
        id: 'f2',
        signer: 's2',
        type: 'signature',
        page: 1,
        x: 0.56,
        y: 0.78,
        width: 0.3,
        height: 0.06,
      },
      {
        id: 'f3',
        signer: 's2',
        type: 'date',
        page: 1,
        x: 0.56,
        y: 0.86,
        width: 0.18,
        height: 0.03,
      },
    ],
    audit: [],
    created: at(1.1),
    created_by: ADA.email,
    sent: at(1),
    updated: at(0.5),
  })
  sent = {
    ...sent,
    audit: fake.audit(sent, [
      { event: 'created', actor: 'sender', email: ADA.email, at: at(1.1) },
      { event: 'sent', actor: 'sender', email: ADA.email, at: at(1) },
      { event: 'consented', actor: 'signer', email: ADA.email, at: at(0.9) },
      { event: 'signed', actor: 'signer', email: ADA.email, at: at(0.9) },
      { event: 'viewed', actor: 'signer', email: 'maya@northwind.example', at: at(0.5) },
    ]),
  }
  fake.envelopes.set(fake.key('ada', out), {
    space: 'ada',
    fm: sent,
    blobOid: newId().toLowerCase(),
  }) // Maya's link works in any tab of the demo (its state lives in the tab), so it can be tried.
  fake.links.set(demoSigningToken(), { key: fake.key('ada', out), signer: 's2' })
}

export function signHandlers(deps: {
  sign: FakeSign
  files: FakeFiles
  latencyMs: number
  principal: (request: Request) => FakeUser | Response
}): AnyHandler[] {
  const { sign: fake, files, latencyMs, principal } = deps
  const read = (space: string, id: string) => fake.envelopes.get(fake.key(space, String(id)))
  const own = (user: FakeUser, s: Stored) => s.space === user.handle || s.space === 'team'

  return [
    http.get('/api/sign', async ({ request }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      await delay(latencyMs)
      const envelopes = [...fake.envelopes.values()]
        .filter((s) => own(user, s))
        .map(summary)
        .sort((a, b) => (b.updated ?? b.created).localeCompare(a.updated ?? a.created))
      return HttpResponse.json({ envelopes })
    }),

    http.post('/api/sign', async ({ request }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      const body = (await request.json()) as { fileSpace: string; fileId: string }
      const file = files.get(body.fileSpace, body.fileId)
      if (!file) return error(404, 'not_found', 'No such file')
      if (file.mime !== 'application/pdf') {
        return error(400, 'bad_request', 'Only a PDF can be sent for signature')
      }
      const now = iso(Date.now())
      const id = newId()
      let fm = EnvelopeFrontmatter.parse({
        id,
        type: 'envelope',
        title: file.name.replace(/\.pdf$/i, ''),
        status: 'draft',
        source: {
          file: file.id,
          space: file.space,
          name: file.name,
          sha256: file.sha256,
          size: file.bytes.length,
          // The demo's PDFs are all one Letter page.
          pages: [{ width: 612, height: 792 }],
        },
        signers: [{ id: 's1', name: user.name, email: user.email, order: 1, status: 'pending' }],
        fields: [],
        audit: [],
        created: now,
        created_by: user.email,
        updated: now,
      })
      fm = {
        ...fm,
        audit: fake.audit(fm, [{ event: 'created', actor: 'sender', email: user.email, at: now }]),
      }
      const stored = { space: user.handle, fm, blobOid: newId().toLowerCase() }
      fake.envelopes.set(fake.key(stored.space, id), stored)
      await delay(latencyMs)
      return HttpResponse.json(view(stored, user.email))
    }),

    http.get('/api/sign/:space/:id', async ({ request, params }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      const s = read(String(params.space), String(params.id))
      if (!s || !own(user, s)) return error(404, 'not_found', 'No such envelope')
      return HttpResponse.json(view(s, user.email))
    }),

    http.get('/api/sign/:space/:id/source.pdf', ({ request, params }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      const s = read(String(params.space), String(params.id))
      const file = s ? files.get(s.fm.source.space, s.fm.source.file) : undefined
      if (!s || !file) return error(404, 'not_found', 'No such envelope')
      return new HttpResponse(file.bytes.slice().buffer, {
        headers: { 'Content-Type': 'application/pdf' },
      })
    }),

    http.put('/api/sign/:space/:id', async ({ request, params }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      const s = read(String(params.space), String(params.id))
      if (!s || !own(user, s)) return error(404, 'not_found', 'No such envelope')
      const body = (await request.json()) as {
        title: string
        fields: SignField[]
        signers?: Signer[]
        signingOrder?: 'parallel' | 'sequential'
        blobOid: string
      }
      if (body.blobOid !== s.blobOid) return error(409, 'conflict', 'Reload to see the change')
      if (s.fm.status !== 'draft') return error(409, 'conflict', 'This is no longer a draft')
      const parsed = EnvelopeFrontmatter.safeParse({
        ...s.fm,
        title: body.title,
        fields: body.fields,
        signers: body.signers ?? s.fm.signers,
        signing_order: body.signingOrder ?? s.fm.signing_order,
        updated: iso(Date.now()),
      })
      if (!parsed.success) return error(400, 'bad_request', parsed.error.issues[0]?.message ?? '')
      s.fm = parsed.data
      s.blobOid = newId().toLowerCase()
      return HttpResponse.json(view(s, user.email))
    }),

    http.post('/api/sign/:space/:id/sign', async ({ request, params }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      const s = read(String(params.space), String(params.id))
      if (!s || !own(user, s)) return error(404, 'not_found', 'No such envelope')
      const body = (await request.json()) as {
        values: FilledValue[]
        consent: boolean
        blobOid: string
      }
      if (!body.consent) return error(400, 'bad_request', 'Agree to sign electronically first')
      const problem = envelopeProblem(s.fm)
      if (problem) return error(400, 'bad_request', problem)
      if (!view(s, user.email).canSign)
        return error(409, 'conflict', 'Nothing left for you to sign')
      const signer = s.fm.signers.find(
        (x) => x.email === user.email.toLowerCase() && x.role !== 'copy',
      )
      if (!signer) return error(409, 'conflict', 'Nothing left for you to sign')
      signAs(fake, files, s, signer, body.values, 'Signed in to Hotsauce')
      await delay(latencyMs)
      return HttpResponse.json(view(s, user.email))
    }),

    http.post('/api/sign/:space/:id/send', async ({ request, params }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      const s = read(String(params.space), String(params.id))
      if (!s || !own(user, s)) return error(404, 'not_found', 'No such envelope')
      const body = (await request.json()) as { blobOid: string }
      if (s.fm.status !== 'draft')
        return error(409, 'conflict', 'This envelope has already been sent')
      if (body.blobOid !== s.blobOid) return error(409, 'conflict', 'Reload to see the change')
      const problem = envelopeProblem(s.fm)
      if (problem) return error(400, 'bad_request', problem)
      const now = iso(Date.now())
      s.fm = { ...s.fm, status: 'sent', sent: now, updated: now }
      s.fm = {
        ...s.fm,
        audit: fake.audit(s.fm, [{ event: 'sent', actor: 'sender', email: user.email, at: now }]),
      }
      const links = issueLinks(fake, s, user.email.toLowerCase())
      s.blobOid = newId().toLowerCase()
      await delay(latencyMs)
      return HttpResponse.json({ ...view(s, user.email), links })
    }),

    http.post('/api/sign/:space/:id/link/:signer', async ({ request, params }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      const s = read(String(params.space), String(params.id))
      if (!s || !own(user, s)) return error(404, 'not_found', 'No such envelope')
      const x = s.fm.signers.find((y) => y.id === params.signer)
      if (s.fm.status !== 'sent' || !x || !view(s, user.email).upNext.includes(x.id)) {
        return error(409, 'conflict', 'It isn’t their turn to sign')
      }
      const link = makeLink(fake, fake.key(s.space, s.fm.id), s.fm.id, x)
      const now = iso(Date.now())
      s.fm = {
        ...s.fm,
        signers: s.fm.signers.map((y) =>
          y.id === x.id ? { ...y, token_hash: fakeHash(now), sent_at: now } : y,
        ),
      }
      s.blobOid = newId().toLowerCase()
      return HttpResponse.json(link)
    }),

    // Fix someone's name or email after sending (R19–R23): whoever is up gets a fresh link.
    http.patch('/api/sign/:space/:id/people/:signer', async ({ request, params }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      const s = read(String(params.space), String(params.id))
      if (!s || !own(user, s)) return error(404, 'not_found', 'No such envelope')
      if (s.fm.status !== 'sent') {
        return error(
          409,
          'conflict',
          'Only an envelope that’s out for signing can have someone corrected',
        )
      }
      const x = s.fm.signers.find((y) => y.id === params.signer)
      if (!x) return error(404, 'not_found', 'No such person on this envelope')
      if (x.status !== 'pending') return error(409, 'conflict', `${x.name} has already answered`)
      const body = (await request.json()) as { name?: string; email?: string }
      const name = (body.name ?? x.name).replace(/\s+/g, ' ').trim()
      const email = (body.email ?? x.email).trim().toLowerCase()
      if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return error(400, 'bad_request', 'That email address isn’t valid')
      }
      if (s.fm.signers.some((y) => y.id !== x.id && y.email === email)) {
        return error(400, 'bad_request', `${email} is already on this envelope`)
      }
      if (name === x.name && email === x.email) {
        return HttpResponse.json({ ...view(s, user.email), link: null })
      }
      const key = fake.key(s.space, s.fm.id)
      for (const [t, v] of fake.links) if (v.key === key && v.signer === x.id) fake.links.delete(t)
      const { token_hash, token_expires, sent_at, viewed_at, ...rest } = x
      let fixed: Signer = { ...rest, name, email }
      let link: SigningLink | null = null
      const turn = view(s, user.email).upNext.includes(x.id)
      if (x.role !== 'copy' && turn && email !== s.fm.created_by.toLowerCase()) {
        link = makeLink(fake, key, s.fm.id, fixed)
        const now = iso(Date.now())
        fixed = { ...fixed, token_hash: fakeHash(x.id + now), sent_at: now }
      }
      const now = iso(Date.now())
      s.fm = {
        ...s.fm,
        signers: s.fm.signers.map((y) => (y.id === x.id ? fixed : y)),
        updated: now,
      }
      s.fm = {
        ...s.fm,
        audit: fake.audit(s.fm, [
          { event: 'signer_corrected', actor: 'sender', email: user.email, at: now },
        ]),
      }
      s.blobOid = newId().toLowerCase()
      await delay(latencyMs)
      return HttpResponse.json({ ...view(s, user.email), link })
    }),

    // A new draft with the same PDF, people and field places, nothing filled in (R24).
    http.post('/api/sign/:space/:id/copy', async ({ request, params }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      const s = read(String(params.space), String(params.id))
      if (!s || !own(user, s)) return error(404, 'not_found', 'No such envelope')
      if (s.fm.status === 'draft') return error(409, 'conflict', 'A draft can’t be copied')
      if (!files.get(s.fm.source.space, s.fm.source.file)) {
        return error(404, 'not_found', 'The PDF this was made from is gone from Files')
      }
      const now = iso(Date.now())
      const id = newId()
      let fm = EnvelopeFrontmatter.parse({
        id,
        type: 'envelope',
        title: s.fm.title,
        status: 'draft',
        signing_order: s.fm.signing_order,
        source: s.fm.source,
        signers: s.fm.signers.map(({ id, name, email, order, role }) => ({
          id,
          name,
          email,
          order,
          role,
        })),
        fields: s.fm.fields.map(({ value, checked, input, image, filled_at, ...f }) => f),
        audit: [],
        created: now,
        created_by: user.email,
        updated: now,
      })
      fm = {
        ...fm,
        audit: fake.audit(fm, [{ event: 'copied', actor: 'sender', email: user.email, at: now }]),
      }
      const stored = { space: s.space, fm, blobOid: newId().toLowerCase() }
      fake.envelopes.set(fake.key(stored.space, id), stored)
      await delay(latencyMs)
      return HttpResponse.json(view(stored, user.email))
    }),

    ...publicHandlers(fake, files, latencyMs),

    http.delete('/api/sign/:space/:id', ({ request, params }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      const k = fake.key(String(params.space), String(params.id))
      const s = fake.envelopes.get(k)
      if (!s || !own(user, s)) return error(404, 'not_found', 'No such envelope')
      fake.envelopes.delete(k)
      return new HttpResponse(null, { status: 204 })
    }),
  ]
}

/** The signing page's routes (`/api/sign-link/:token`), for people outside the team. */
function publicHandlers(fake: FakeSign, files: FakeFiles, latencyMs: number): AnyHandler[] {
  const find = (token: string) => {
    const at = fake.links.get(token)
    const s = at ? fake.envelopes.get(at.key) : undefined
    const signer = s?.fm.signers.find((x) => x.id === at?.signer)
    return s && signer ? { s, signer } : null
  }
  const gone = () =>
    error(404, 'not_found', 'This signing link doesn’t work. Ask whoever sent it for a new one.')
  const publicView = (s: Stored, signer: Signer): PublicEnvelope => ({
    title: s.fm.title,
    sender:
      s.fm.signers.find((x) => x.email === s.fm.created_by)?.name ??
      (s.fm.created_by === ADA.email ? ADA.name : s.fm.created_by),
    org: 'Acme',
    signer: { id: signer.id, name: signer.name, email: signer.email },
    source: { name: s.fm.source.name, pages: s.fm.source.pages },
    fields: s.fm.fields.filter((f) => f.signer === signer.id),
    status:
      s.fm.status === 'sent'
        ? signer.status === 'pending'
          ? 'ready'
          : signer.status === 'signed'
            ? 'signed'
            : 'declined'
        : s.fm.status === 'completed'
          ? 'completed'
          : s.fm.status === 'declined'
            ? 'declined'
            : 'voided',
  })
  return [
    http.get('/api/sign-link/:token', async ({ params }) => {
      const found = find(String(params.token))
      if (!found) return gone()
      const { s, signer } = found
      if (!signer.viewed_at && s.fm.status === 'sent') {
        const now = iso(Date.now())
        s.fm = {
          ...s.fm,
          signers: s.fm.signers.map((x) => (x.id === signer.id ? { ...x, viewed_at: now } : x)),
        }
        s.fm = {
          ...s.fm,
          audit: fake.audit(s.fm, [
            { event: 'viewed', actor: 'signer', email: signer.email, at: now },
          ]),
        }
      }
      await delay(latencyMs)
      return HttpResponse.json(publicView(s, signer))
    }),

    http.get('/api/sign-link/:token/source.pdf', ({ params }) => {
      const found = find(String(params.token))
      const file = found ? files.get(found.s.fm.source.space, found.s.fm.source.file) : undefined
      if (!found || !file) return gone()
      return new HttpResponse(file.bytes.slice().buffer, {
        headers: { 'Content-Type': 'application/pdf' },
      })
    }),

    http.post('/api/sign-link/:token/sign', async ({ request, params }) => {
      const found = find(String(params.token))
      if (!found) return gone()
      const { s, signer } = found
      const body = (await request.json()) as { values: FilledValue[]; consent: boolean }
      if (!body.consent) return error(400, 'bad_request', 'Agree to sign electronically first')
      if (s.fm.status !== 'sent' || signer.status !== 'pending') {
        return error(409, 'conflict', 'This can’t be signed now')
      }
      signAs(fake, files, s, signer, body.values, 'Email link')
      await delay(latencyMs)
      const now = s.fm.signers.find((x) => x.id === signer.id) ?? signer
      return HttpResponse.json(publicView(s, now))
    }),

    http.post('/api/sign-link/:token/decline', async ({ request, params }) => {
      const found = find(String(params.token))
      if (!found) return gone()
      const { s, signer } = found
      if (s.fm.status !== 'sent' || signer.status !== 'pending') {
        return error(409, 'conflict', 'This can’t be declined now')
      }
      const body = (await request.json()) as { reason?: string }
      const reason = (body.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 500)
      const now = iso(Date.now())
      s.fm = {
        ...s.fm,
        status: 'declined',
        declined: now,
        updated: now,
        signers: s.fm.signers.map((x) =>
          x.id === signer.id
            ? {
                ...x,
                status: 'declined',
                declined_at: now,
                ...(reason ? { decline_reason: reason } : {}),
              }
            : x,
        ),
      }
      s.fm = {
        ...s.fm,
        audit: fake.audit(s.fm, [
          { event: 'declined', actor: 'signer', email: signer.email, at: now },
        ]),
      }
      s.blobOid = newId().toLowerCase()
      const after = s.fm.signers.find((x) => x.id === signer.id) ?? signer
      return HttpResponse.json(publicView(s, after))
    }),
  ]
}
