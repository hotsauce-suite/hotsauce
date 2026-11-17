// MSW routes for Sign (`/api/sign`; docs/PLAN-sign.md), in memory and shaped like the server's
// (apps/server/src/sign). The demo can't seal a PDF in the browser: its "signed" copy is the
// original, and its certificate a plain page listing the audit trail. The real server stamps the
// fields and seals both with @hotsauce/sign.

import {
  type AuditEntry,
  EnvelopeFrontmatter,
  envelopeProblem,
  newId,
  type SignField,
} from '@hotsauce/format'
import { type AnyHandler, delay, HttpResponse, http } from 'msw'
import type { EnvelopeSummary, EnvelopeView, FilledValue } from '../api/sign'
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
  const mine = fm.signers.find((x) => x.email === me.toLowerCase())
  return {
    ...summary(s),
    source: fm.source,
    signerList: fm.signers,
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
      (fm.status === 'draft' || fm.status === 'sent') &&
      mine?.status === 'pending' &&
      envelopeProblem(fm) === null,
    blobOid: s.blobOid,
  }
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
      const body = (await request.json()) as { title: string; fields: SignField[]; blobOid: string }
      if (body.blobOid !== s.blobOid) return error(409, 'conflict', 'Reload to see the change')
      if (s.fm.status !== 'draft') return error(409, 'conflict', 'This is no longer a draft')
      const parsed = EnvelopeFrontmatter.safeParse({
        ...s.fm,
        title: body.title,
        fields: body.fields,
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
      const signer = s.fm.signers.find((x) => x.email === user.email.toLowerCase())
      if (!signer || signer.status !== 'pending') {
        return error(409, 'conflict', 'Nothing left for you to sign')
      }
      const now = iso(Date.now())
      const byId = new Map(body.values.map((v) => [v.field, v]))
      const fields = s.fm.fields.map((f): SignField => {
        if (f.signer !== signer.id) return f
        const v = byId.get(f.id)
        if (f.type === 'checkbox') return { ...f, checked: v?.checked === true, filled_at: now }
        if (f.type === 'date') return { ...f, value: now.slice(0, 10), filled_at: now }
        if (v?.image) return { ...f, input: 'drawn', image: v.image, filled_at: now }
        return v?.value ? { ...f, input: 'typed', value: v.value, filled_at: now } : f
      })
      let fm: EnvelopeFrontmatter = {
        ...s.fm,
        fields,
        status: 'completed',
        completed: now,
        updated: now,
        signers: s.fm.signers.map((x) =>
          x.id === signer.id ? { ...x, status: 'signed', signed_at: now } : x,
        ),
      }
      fm = {
        ...fm,
        audit: fake.audit(fm, [
          { event: 'consented', actor: 'signer', email: user.email, at: now },
          { event: 'signed', actor: 'signer', email: user.email, at: now },
          { event: 'completed', actor: 'system', email: null, at: now },
        ]),
      }
      s.fm = { ...fm, result: finish(files, fm, user.email) }
      s.blobOid = newId().toLowerCase()
      await delay(latencyMs)
      return HttpResponse.json(view(s, user.email))
    }),

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
