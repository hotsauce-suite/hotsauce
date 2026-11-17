// Hotsauce Sign (docs/PLAN-sign.md): an envelope is `sign/<id>.md`, in the sender's personal space
// unless they share it. Its frontmatter is the truth: the PDF it was made from (a Files id and that
// PDF's SHA-256), the signers, the fields placed on the pages and the audit trail as a hash chain.
// When the last signer signs, the engine (@hotsauce/sign) stamps the fields, seals the PDF and makes
// an audit certificate; both are saved into Files beside the original.

import { createHash } from 'node:crypto'
import {
  type AuditEntry,
  EnvelopeFrontmatter,
  envelopePath,
  envelopeProblem,
  isEnvelopeId,
  MAX_SIGN_PAGES,
  MAX_SIGN_PDF_BYTES,
  parseFrontmatter,
  type Signer,
  type SignField,
  SPACE_LAYOUT,
} from '@hotsauce/format'
import {
  type AuditEventRecord,
  type ChainedEvent,
  chainAuditEvents,
  type EnvelopeRecord,
  type FieldRecord,
  makeSealer,
  type PdfSealer,
  pdfFingerprint,
  readPdfPages,
  renderCertificate,
  renderSignedPdf,
  type SealIdentity,
  type SignerRecord,
  SourceDocumentChangedError,
  verifyAuditChain,
} from '@hotsauce/sign'
import { ulid } from 'ulid'
import { stringify as toYaml } from 'yaml'
import type { Principal } from '../auth/index.js'
import { HotsauceError } from '../errors.js'
import type { Files } from '../files/index.js'
import {
  type Author,
  type Change,
  formatCommitMessage,
  type GitStore,
  withVia,
} from '../git/index.js'
import type { Index } from '../index/index.js'
import type { SpaceService } from '../spaces/index.js'
import type { Syncer } from '../sync/index.js'

export interface EnvelopeSummary {
  space: string
  id: string
  title: string
  status: EnvelopeFrontmatter['status']
  sourceName: string
  signers: Array<Pick<Signer, 'name' | 'email' | 'status'>>
  created: string
  createdBy: string
  updated: string | null
  completed: string | null
}

export interface EnvelopeView extends EnvelopeSummary {
  source: EnvelopeFrontmatter['source']
  signerList: Signer[]
  fields: SignField[]
  audit: AuditEntry[]
  /** Whether the audit trail's hash chain checks out. */
  auditIntact: boolean
  /** The sealed PDF and certificate in Files, once finished. */
  result: { space: string; signedFile: string; certificateFile: string } | null
  /** Whether the member reading this is a signer who still has to sign. */
  canSign: boolean
  blobOid: string
}

export interface DraftInput {
  title: string
  /** Checked in full by the format's schema. */
  fields: unknown[]
  blobOid: string
}

/** What a signer typed, drew or ticked, by field id. */
export interface FilledValue {
  field: string
  value?: string | undefined
  checked?: boolean | undefined
  /** A drawn signature or initials, as a PNG data URL. */
  image?: string | undefined
}

export interface RequestMeta {
  ip: string | null
  agent: string | null
}

export interface SignDeps {
  git: Pick<GitStore, 'readFile' | 'commit'>
  index: Pick<Index, 'listFiles' | 'listSpaces'>
  spaces: Pick<SpaceService, 'canAccess' | 'visibleSpaces'>
  syncer: Pick<Syncer, 'afterHeadChanged'>
  files: Pick<Files, 'get' | 'bytes' | 'storeFormFile' | 'available' | 'remove'>
  /** The install's seal key, made on first use (state/seal-key.ts). */
  sealKey: () => SealIdentity
  /** Shown in a PDF reader's signature panel: the organization, else the product. */
  orgName: string
  productName: string
  now?: () => Date
}

const PNG = [0x89, 0x50, 0x4e, 0x47]

export class Sign {
  readonly #deps: SignDeps
  readonly #now: () => Date
  #sealer: PdfSealer | null = null
  /** The signing running for each envelope (`space/id`), so they run one after another. */
  readonly #signing = new Map<string, Promise<void>>()

  constructor(deps: SignDeps) {
    this.#deps = deps
    this.#now = deps.now ?? (() => new Date())
  }

  /** Envelopes in every space the member can open, newest change first. */
  list(principal: Principal): EnvelopeSummary[] {
    const out: EnvelopeSummary[] = []
    for (const { name } of this.#deps.index.listSpaces()) {
      if (!this.#deps.spaces.canAccess(principal, name)) continue
      for (const row of this.#deps.index.listFiles({ space: name, kind: 'envelope' })) {
        const fm = EnvelopeFrontmatter.safeParse(row.frontmatter ?? {})
        if (fm.success && row.path === envelopePath(fm.data.id)) out.push(summary(name, fm.data))
      }
    }
    return out.sort((a, b) => (b.updated ?? b.created).localeCompare(a.updated ?? a.created))
  }

  /**
   * A draft envelope for a PDF in Files, with the member as its one signer. It's kept in the
   * member's personal space unless `space` names another they can open (Q6).
   */
  async create(
    principal: Principal,
    input: {
      fileSpace: string
      fileId: string
      title?: string | undefined
      space?: string | undefined
    },
    via?: string,
  ): Promise<EnvelopeView> {
    const file = await this.#deps.files.get(principal, input.fileSpace, input.fileId)
    if (file.mime !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      throw new HotsauceError('bad_request', 'Only a PDF can be sent for signature')
    }
    if (file.size > MAX_SIGN_PDF_BYTES) {
      throw new HotsauceError('bad_request', 'This PDF is over 25 MB, too big to sign')
    }
    const bytes = await this.#sourceBytes(input.fileSpace, file.id, file.sha256)
    const pages = await readPdfPages(bytes).catch(() => {
      throw new HotsauceError(
        'bad_request',
        'This PDF can’t be opened for signing; it may be locked with a password or damaged',
      )
    })
    if (pages.some((p) => !p.plain)) {
      throw new HotsauceError(
        'bad_request',
        'This PDF has turned or cropped pages, which Sign can’t place fields on yet. Print it to a new PDF and try that.',
      )
    }
    if (pages.length === 0 || pages.length > MAX_SIGN_PAGES) {
      throw new HotsauceError(
        'bad_request',
        `A PDF to sign can have at most ${MAX_SIGN_PAGES} pages`,
      )
    }
    const space = input.space ?? (await this.#personalSpace(principal))
    this.#assertAccess(principal, space)
    const id = ulid()
    const now = this.#iso()
    const title =
      (input.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) ||
      file.name.replace(/\.pdf$/i, '').slice(0, 200) ||
      'Untitled'
    const base = {
      id,
      type: 'envelope' as const,
      title,
      status: 'draft' as const,
      source: {
        file: file.id,
        space: input.fileSpace,
        name: file.name,
        sha256: file.sha256,
        size: file.size,
        pages: pages.map((p) => ({ width: round(p.width), height: round(p.height) })),
      },
      signers: [
        {
          id: 's1',
          name: (principal.name || principal.email).slice(0, 120),
          email: principal.email,
          order: 1,
          status: 'pending' as const,
        },
      ],
      fields: [],
      created: now,
      created_by: principal.email,
      updated: now,
    }
    const fm = EnvelopeFrontmatter.parse({
      ...base,
      audit: chain(
        id,
        [],
        [
          {
            event: 'created',
            actor: 'sender',
            email: principal.email,
            meta: { file: file.name, sha256: file.sha256 },
            at: now,
          },
        ],
      ),
    })
    await this.#commit(space, principal, {
      changes: [{ path: envelopePath(id), content: envelopeFile(fm) }],
      verb: 'create',
      title,
      via,
      unchanged: { path: envelopePath(id), blobOid: null },
    })
    return this.get(principal, space, id)
  }

  async get(principal: Principal, space: string, id: string): Promise<EnvelopeView> {
    this.#assertAccess(principal, space)
    const { fm, blobOid } = await this.#read(space, id)
    return this.#view(principal, space, fm, blobOid)
  }

  /** The PDF the envelope was made from, for placing fields; refused once it has changed. */
  async source(principal: Principal, space: string, id: string): Promise<Uint8Array> {
    this.#assertAccess(principal, space)
    const { fm } = await this.#read(space, id)
    // The PDF can sit in another space than the envelope: whoever reads it needs both.
    this.#assertAccess(principal, fm.source.space)
    return this.#sourceBytes(fm.source.space, fm.source.file, fm.source.sha256)
  }

  /** Saves a draft's title and fields; `blobOid` is the version edited, and another is a 409. */
  async saveDraft(
    principal: Principal,
    space: string,
    id: string,
    input: DraftInput,
    via?: string,
  ): Promise<EnvelopeView> {
    this.#assertAccess(principal, space)
    const { fm } = await this.#read(space, id)
    if (fm.status !== 'draft') {
      throw new HotsauceError('conflict', 'This envelope is no longer a draft, so it can’t change')
    }
    // A draft places fields; nothing is filled in until someone signs.
    const fields = input.fields.map((f) =>
      f && typeof f === 'object'
        ? Object.fromEntries(
            Object.entries(f).filter(
              ([k]) => !['value', 'checked', 'input', 'image', 'filled_at'].includes(k),
            ),
          )
        : f,
    )
    const parsed = EnvelopeFrontmatter.safeParse({
      ...fm,
      title: input.title.replace(/\s+/g, ' ').trim(),
      fields,
      updated: this.#iso(),
    })
    if (!parsed.success) throw badInput(parsed.error.issues[0])
    const problem = fieldsProblem(parsed.data)
    if (problem) throw new HotsauceError('bad_request', problem)
    await this.#commit(space, principal, {
      changes: [{ path: envelopePath(id), content: envelopeFile(parsed.data) }],
      verb: 'edit',
      title: parsed.data.title,
      via,
      unchanged: { path: envelopePath(id), blobOid: input.blobOid },
    })
    return this.get(principal, space, id)
  }

  /**
   * The member signs their fields. When nobody else is left to sign, the sealed PDF and its
   * certificate are made and saved into Files beside the original, and the envelope is completed.
   */
  async sign(
    principal: Principal,
    space: string,
    id: string,
    input: { values: FilledValue[]; consent: boolean; blobOid: string },
    meta: RequestMeta,
    via?: string,
  ): Promise<EnvelopeView> {
    this.#assertAccess(principal, space)
    // One signing at a time per envelope, so two presses of Finish can't both seal a copy.
    const key = `${space}/${id}`
    const before = this.#signing.get(key) ?? Promise.resolve()
    const run = before.then(() => this.#signOnce(principal, space, id, input, meta, via))
    const settled = run.then(
      () => undefined,
      () => undefined,
    )
    this.#signing.set(key, settled)
    try {
      return await run
    } finally {
      if (this.#signing.get(key) === settled) this.#signing.delete(key)
    }
  }

  async #signOnce(
    principal: Principal,
    space: string,
    id: string,
    input: { values: FilledValue[]; consent: boolean; blobOid: string },
    meta: RequestMeta,
    via?: string,
  ): Promise<EnvelopeView> {
    const { fm, blobOid } = await this.#read(space, id)
    if (fm.status !== 'draft' && fm.status !== 'sent') {
      throw new HotsauceError('conflict', 'This envelope is finished; nothing is left to sign')
    }
    // Checked before anything is sealed, so a stale page never leaves copies in Files.
    if (blobOid !== input.blobOid) {
      throw new HotsauceError('conflict', 'This envelope changed since you opened it; reload it')
    }
    const signer = fm.signers.find((s) => s.email === principal.email.toLowerCase())
    if (!signer) throw new HotsauceError('forbidden', 'You aren’t a signer of this envelope')
    if (signer.status !== 'pending') {
      throw new HotsauceError('conflict', 'You have already signed this envelope')
    }
    if (!input.consent) {
      throw new HotsauceError('bad_request', 'Agree to sign electronically first')
    }
    const problem = envelopeProblem(fm)
    if (problem) throw new HotsauceError('bad_request', problem)

    const now = this.#iso()
    const fields = fillFields(fm.fields, signer.id, input.values, now)
    const signers = fm.signers.map((s) =>
      s.id === signer.id ? { ...s, status: 'signed' as const, signed_at: now } : s,
    )
    const who = {
      actor: 'signer' as const,
      email: signer.email,
      ip: meta.ip,
      agent: meta.agent,
      at: now,
    }
    let audit = chain(fm.id, fm.audit, [
      { ...who, event: 'consented', meta: { signerId: signer.id, signerName: signer.name } },
      {
        ...who,
        event: 'signed',
        meta: {
          signerId: signer.id,
          signerName: signer.name,
          signerEmail: signer.email,
          // Members sign in to Hotsauce; that is how they were checked.
          method: 'Signed in to Hotsauce',
          // What they filled in, so an edit to the fields afterwards breaks the audit check.
          fieldsSha256: filledDigest(fields, signer.id),
        },
      },
    ])
    let next: EnvelopeFrontmatter = { ...fm, fields, signers, audit, updated: now }
    const changes: Change[] = []
    if (signers.every((s) => s.status === 'signed')) {
      audit = chain(fm.id, audit, [
        {
          event: 'completed',
          actor: 'system',
          email: null,
          ip: null,
          agent: null,
          meta: null,
          at: now,
        },
      ])
      next = { ...next, audit, status: 'completed', completed: now }
    }
    // Checked with a stand-in result before sealing, so a bad envelope leaves nothing in Files.
    const placeholder = {
      signed_file: ulid(),
      certificate_file: ulid(),
      signed_sha256: '0'.repeat(64),
    }
    const check = EnvelopeFrontmatter.safeParse(
      next.status === 'completed' ? { ...next, result: placeholder } : next,
    )
    if (!check.success) throw badInput(check.error.issues[0])
    const stored: string[] = []
    try {
      if (next.status === 'completed') {
        next = { ...next, result: await this.#finish(principal, next, stored) }
      }
      const parsed = EnvelopeFrontmatter.safeParse(next)
      if (!parsed.success) throw badInput(parsed.error.issues[0])
      changes.push({ path: envelopePath(id), content: envelopeFile(parsed.data) })
      await this.#commit(space, principal, {
        changes,
        verb: 'sign',
        title: fm.title,
        via,
        unchanged: { path: envelopePath(id), blobOid: input.blobOid },
      })
    } catch (err) {
      // Nothing points at copies sealed for a sign that didn't land: take them back out.
      for (const fileId of stored) {
        await this.#deps.files.remove(principal, fm.source.space, fileId).catch(() => undefined)
      }
      throw err
    }
    return this.get(principal, space, id)
  }

  /** Moves the envelope to the space's trash. A finished one's PDFs stay in Files. */
  async remove(principal: Principal, space: string, id: string, via?: string): Promise<void> {
    this.#assertAccess(principal, space)
    const { fm, content, blobOid } = await this.#read(space, id)
    const trash = `${SPACE_LAYOUT.trash}/${this.#iso().slice(0, 10)}-${id.slice(-8)}`
    await this.#commit(space, principal, {
      changes: [
        { path: `${trash}/${envelopePath(id)}`, content },
        { path: envelopePath(id), content: null },
      ],
      verb: 'delete',
      title: fm.title,
      via,
      unchanged: { path: envelopePath(id), blobOid },
    })
  }

  // ── internals ────────────────────────────────────────────────────────

  /** Seals the signed PDF and the certificate and saves both into Files beside the original. */
  async #finish(
    principal: Principal,
    fm: EnvelopeFrontmatter,
    stored: string[],
  ): Promise<NonNullable<EnvelopeFrontmatter['result']>> {
    const original = await this.#deps.files
      .get(principal, fm.source.space, fm.source.file)
      .catch((err) => {
        throw err instanceof HotsauceError && err.code === 'not_found'
          ? new HotsauceError('conflict', 'The PDF this was made from is gone from Files')
          : err
      })
    const source = await this.#sourceBytes(fm.source.space, fm.source.file, fm.source.sha256)
    const records = toRecords(fm)
    const seal = this.#seal()
    const signed = await renderSignedPdf(
      {
        source,
        envelope: records.envelope,
        signers: records.signers,
        fields: records.fields,
        images: records.images,
        completedAt: seconds(fm.completed ?? this.#iso()),
      },
      seal,
    ).catch((err) => {
      if (err instanceof SourceDocumentChangedError) throw changed()
      throw err
    })
    const signedSha256 = pdfFingerprint(signed)
    const certificate = await renderCertificate(
      {
        envelope: { ...records.envelope, signedPdfSha256: signedSha256 },
        signers: records.signers,
        auditEvents: records.audit,
        signedPdfSha256: signedSha256,
        productName: this.#deps.productName,
      },
      seal,
    )
    const stem = fm.source.name.replace(/\.pdf$/i, '')
    const store = (name: string, bytes: Uint8Array) =>
      this.#deps.files.storeFormFile(
        principal,
        { space: fm.source.space, folder: original.folder, name, mime: 'application/pdf', bytes },
        undefined,
      )
    const signedFile = await store(`${stem} (signed).pdf`, signed)
    stored.push(signedFile.id)
    const certificateFile = await store(`${stem} (certificate).pdf`, certificate)
    stored.push(certificateFile.id)
    return {
      signed_file: signedFile.id,
      certificate_file: certificateFile.id,
      signed_sha256: signedSha256,
    }
  }

  #seal(): PdfSealer {
    this.#sealer ??= makeSealer(this.#deps.sealKey(), {
      name: this.#deps.orgName,
      productName: this.#deps.productName,
    })
    return this.#sealer
  }

  async #sourceBytes(space: string, fileId: string, sha256: string): Promise<Uint8Array> {
    if (!this.#deps.files.available) {
      throw new HotsauceError('not_configured', 'Files isn’t set up on this server')
    }
    const bytes = await this.#deps.files.bytes(space, fileId, MAX_SIGN_PDF_BYTES)
    if (!bytes) throw new HotsauceError('not_found', 'The PDF is gone from Files')
    if (pdfFingerprint(bytes) !== sha256) throw changed()
    return bytes
  }

  async #personalSpace(principal: Principal): Promise<string> {
    const visible = await this.#deps.spaces.visibleSpaces(principal)
    const personal = visible.find((s) => s.kind === 'personal')?.name
    if (!personal)
      throw new HotsauceError('conflict', 'You need a private space to keep envelopes in')
    return personal
  }

  async #read(space: string, id: string) {
    if (!isEnvelopeId(id)) throw notFound()
    const file = await this.#deps.git.readFile(space, envelopePath(id)).catch((err) => {
      throw err instanceof HotsauceError && err.code === 'not_found' ? notFound() : err
    })
    const parsed = EnvelopeFrontmatter.safeParse(parseFrontmatter(file.content).data)
    if (!parsed.success || parsed.data.id !== id) {
      throw new HotsauceError('conflict', 'This envelope’s file can’t be read; fix it in Git')
    }
    return { fm: parsed.data, content: file.content, blobOid: file.blobOid }
  }

  #view(
    principal: Principal,
    space: string,
    fm: EnvelopeFrontmatter,
    blobOid: string,
  ): EnvelopeView {
    const me = fm.signers.find((s) => s.email === principal.email.toLowerCase())
    return {
      ...summary(space, fm),
      source: fm.source,
      signerList: fm.signers,
      fields: fm.fields,
      audit: fm.audit,
      auditIntact:
        verifyAuditChain(fm.audit.map((a) => toChained(fm.id, a))).ok && fieldsMatchAudit(fm),
      result: fm.result
        ? {
            space: fm.source.space,
            signedFile: fm.result.signed_file,
            certificateFile: fm.result.certificate_file,
          }
        : null,
      canSign:
        (fm.status === 'draft' || fm.status === 'sent') &&
        me?.status === 'pending' &&
        envelopeProblem(fm) === null,
      blobOid,
    }
  }

  async #commit(
    space: string,
    author: Author,
    args: {
      changes: Change[]
      verb: string
      title: string
      via: string | undefined
      unchanged: { path: string; blobOid: string | null }
    },
  ): Promise<void> {
    const result = await this.#deps.git
      .commit(space, {
        changes: args.changes,
        author,
        message: withVia(
          formatCommitMessage({
            app: 'sign',
            verb: args.verb,
            title: args.title.replace(/"/g, "'"),
          }),
          args.via,
        ),
        unchanged: args.unchanged,
      })
      .catch((err) => {
        throw err instanceof HotsauceError && err.code === 'conflict' ? stale() : err
      })
    if (result.status === 'conflict') throw stale()
    await this.#deps.syncer.afterHeadChanged(space)
  }

  #assertAccess(principal: Principal, space: string) {
    if (!this.#deps.spaces.canAccess(principal, space)) {
      throw new HotsauceError('forbidden', `You don't have access to the space "${space}"`)
    }
  }

  #iso(): string {
    return this.#now()
      .toISOString()
      .replace(/\.\d+Z$/, 'Z')
  }
}

// ── helpers ────────────────────────────────────────────────────────────

type NewEvent = Pick<AuditEntry, 'event' | 'actor' | 'at'> & {
  email: string | null
  ip?: string | null
  agent?: string | null
  meta: Record<string, unknown> | null
}

const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000)
const round = (n: number) => Math.round(n * 100) / 100

function toChained(envelopeId: string, a: AuditEntry): ChainedEvent {
  return {
    actorEmail: a.email,
    actorType: a.actor,
    createdAt: seconds(a.at),
    envelopeId,
    event: a.event,
    id: a.id,
    ipAddress: a.ip,
    metadata: a.meta,
    sequence: a.seq,
    userAgent: a.agent,
    prevHash: a.prev,
    rowHash: a.hash,
  }
}

/** Appends events to the trail, each hashed with the one before it (R5). */
export function chain(
  envelopeId: string,
  previous: readonly AuditEntry[],
  next: readonly NewEvent[],
): AuditEntry[] {
  const chained = chainAuditEvents(
    previous.map((a) => toChained(envelopeId, a)),
    next.map((e) => ({
      actorEmail: e.email,
      actorType: e.actor,
      createdAt: seconds(e.at),
      envelopeId,
      event: e.event,
      id: ulid(),
      ipAddress: e.ip ?? null,
      metadata: e.meta,
      userAgent: e.agent ?? null,
    })),
  )
  return [
    ...previous,
    ...chained.slice(previous.length).map((c, i) => ({
      seq: c.sequence,
      id: c.id,
      at: next[i]?.at ?? '',
      event: c.event as AuditEntry['event'],
      actor: c.actorType as AuditEntry['actor'],
      email: c.actorEmail,
      ip: c.ipAddress,
      agent: c.userAgent,
      meta: c.metadata,
      prev: c.prevHash,
      hash: c.rowHash,
    })),
  ]
}

/** Places that can't hold a field: fields must belong to a signer, on a page the PDF has. */
function fieldsProblem(fm: EnvelopeFrontmatter): string | null {
  const signers = new Set(fm.signers.map((s) => s.id))
  const ids = new Set<string>()
  for (const f of fm.fields) {
    if (ids.has(f.id)) return 'Two fields have the same id'
    ids.add(f.id)
    if (!signers.has(f.signer)) return 'A field belongs to nobody on the list'
    if (f.page > fm.source.pages.length) return `A field is on page ${f.page}, which isn't there`
  }
  return null
}

/** The signer's fields filled from what they sent; a required field left empty is refused. */
function fillFields(
  fields: readonly SignField[],
  signerId: string,
  values: readonly FilledValue[],
  now: string,
): SignField[] {
  const byId = new Map(values.map((v) => [v.field, v]))
  for (const v of values) {
    const f = fields.find((x) => x.id === v.field)
    if (!f || f.signer !== signerId)
      throw new HotsauceError('bad_request', 'That field isn’t yours to fill')
  }
  return fields.map((f) => {
    if (f.signer !== signerId) return f
    const v = byId.get(f.id)
    const label = FIELD_LABEL[f.type]
    if (f.type === 'checkbox') {
      if (f.required && v?.checked !== true) {
        throw new HotsauceError('bad_request', 'Tick every required box')
      }
      return { ...f, checked: v?.checked === true, filled_at: now }
    }
    if (f.type === 'date') {
      return { ...f, value: dateSigned(v?.value, now), filled_at: now }
    }
    if (f.type === 'signature' || f.type === 'initials') {
      if (v?.image) {
        if (!isPng(v.image)) throw new HotsauceError('bad_request', `Draw your ${label} again`)
        if (!pngFits(v.image)) {
          throw new HotsauceError(
            'bad_request',
            `Your drawn ${label} is too big; clear it and draw it again`,
          )
        }
        return { ...f, input: 'drawn', image: v.image, value: undefined, filled_at: now }
      }
      const typed = v?.value?.replace(/\s+/g, ' ').trim().slice(0, 200)
      if (!typed) throw new HotsauceError('bad_request', `Add your ${label}`)
      return { ...f, input: 'typed', value: typed, image: undefined, filled_at: now }
    }
    const text = v?.value?.trim().slice(0, 5000)
    if (!text && f.required) throw new HotsauceError('bad_request', 'Fill in every required field')
    return text ? { ...f, value: text, filled_at: now } : f
  })
}

const FIELD_LABEL: Record<SignField['type'], string> = {
  signature: 'signature',
  initials: 'initials',
  date: 'date',
  text: 'text',
  checkbox: 'checkbox',
}

/**
 * The date a date field shows: the signer's own calendar date (their device sends it), so an
 * evening in New York isn't stamped with tomorrow's UTC date; anything else, or a date more than
 * a day from the server's, gets the server's date. A signer can't backdate a signature.
 */
function dateSigned(sent: string | undefined, now: string): string {
  const today = now.slice(0, 10)
  const v = sent?.trim() ?? ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return today
  const day = Date.parse(`${v}T00:00:00Z`)
  if (Number.isNaN(day)) return today
  return Math.abs(day - Date.parse(`${today}T00:00:00Z`)) <= 86_400_000 ? v : today
}

/** A digest of what one signer filled in: the fields' places and values, in id order. */
function filledDigest(fields: readonly SignField[], signerId: string): string {
  const mine = fields
    .filter((f) => f.signer === signerId)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((f) => [
      f.id,
      f.type,
      f.page,
      f.x,
      f.y,
      f.width,
      f.height,
      f.value ?? null,
      f.checked ?? null,
      f.image ?? null,
    ])
  return createHash('sha256').update(JSON.stringify(mine)).digest('hex')
}

/** Whether each signer's fields are still what their signed event recorded. */
function fieldsMatchAudit(fm: EnvelopeFrontmatter): boolean {
  for (const a of fm.audit) {
    if (a.event !== 'signed') continue
    const m = (a.meta ?? {}) as Record<string, unknown>
    if (typeof m.fieldsSha256 !== 'string' || typeof m.signerId !== 'string') continue
    if (filledDigest(fm.fields, m.signerId) !== m.fieldsSha256) return false
  }
  return true
}

/** Drawn signatures are small: a PNG claiming more than 4000 by 2000 pixels is refused. */
function pngFits(dataUrl: string): boolean {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1, dataUrl.indexOf(',') + 1 + 32)
  const head = Buffer.from(b64, 'base64')
  if (head.length < 24) return false
  const width = head.readUInt32BE(16)
  const height = head.readUInt32BE(20)
  return width > 0 && height > 0 && width <= 4000 && height <= 2000
}

function isPng(dataUrl: string): boolean {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/]+=*)$/.exec(dataUrl)
  if (!m?.[1]) return false
  const head = Buffer.from(m[1].slice(0, 16), 'base64')
  return PNG.every((b, i) => head[i] === b)
}

/** The envelope as the engine's records, with each drawn signature's PNG by its field id. */
function toRecords(fm: EnvelopeFrontmatter): {
  envelope: EnvelopeRecord
  signers: SignerRecord[]
  fields: FieldRecord[]
  audit: AuditEventRecord[]
  images: Map<string, Uint8Array>
} {
  const created = seconds(fm.created)
  const updated = seconds(fm.updated ?? fm.created)
  const envelope: EnvelopeRecord = {
    id: fm.id,
    userId: fm.created_by,
    title: fm.title,
    status: fm.status,
    sourcePdfKey: `files/${fm.source.file}`,
    sourcePdfFilename: fm.source.name,
    sourcePdfSizeBytes: fm.source.size,
    pageCount: fm.source.pages.length,
    sourcePdfHash: fm.source.sha256,
    signedPdfKey: null,
    evidenceKey: null,
    sentAt: fm.sent ? seconds(fm.sent) : created,
    completedAt: fm.completed ? seconds(fm.completed) : null,
    declinedAt: null,
    voidedAt: null,
    createdAt: created,
    updatedAt: updated,
  }
  const signers: SignerRecord[] = fm.signers.map((s) => ({
    id: s.id,
    envelopeId: fm.id,
    name: s.name,
    email: s.email,
    signOrder: s.order,
    status: s.status,
    signedAt: s.signed_at ? seconds(s.signed_at) : null,
    createdAt: created,
    updatedAt: s.signed_at ? seconds(s.signed_at) : created,
  }))
  const images = new Map<string, Uint8Array>()
  const fields: FieldRecord[] = fm.fields.map((f) => {
    if (f.image) {
      images.set(f.id, Buffer.from(f.image.slice(f.image.indexOf(',') + 1), 'base64'))
    }
    return {
      id: f.id,
      envelopeId: fm.id,
      signerId: f.signer,
      type: f.type,
      page: f.page,
      x: f.x,
      y: f.y,
      width: f.width,
      height: f.height,
      required: f.required,
      inputMethod: f.input ?? null,
      value: f.value ?? null,
      checked: f.checked ?? null,
      imageKey: f.image ? f.id : null,
      submittedAt: f.filled_at ? seconds(f.filled_at) : null,
      createdAt: created,
      updatedAt: f.filled_at ? seconds(f.filled_at) : created,
    }
  })
  const audit: AuditEventRecord[] = fm.audit.map((a) => ({
    id: a.id,
    envelopeId: fm.id,
    event: a.event,
    actorType: a.actor,
    actorEmail: a.email,
    ipAddress: a.ip,
    userAgent: a.agent,
    metadata: a.meta,
    createdAt: seconds(a.at),
  }))
  return { envelope, signers, fields, audit, images }
}

function summary(space: string, fm: EnvelopeFrontmatter): EnvelopeSummary {
  return {
    space,
    id: fm.id,
    title: fm.title,
    status: fm.status,
    sourceName: fm.source.name,
    signers: fm.signers.map((s) => ({ name: s.name, email: s.email, status: s.status })),
    created: fm.created,
    createdBy: fm.created_by,
    updated: fm.updated ?? null,
    completed: fm.completed ?? null,
  }
}

/** The file: frontmatter is the truth; the body is a readable copy of who signed and when. */
export function envelopeFile(fm: EnvelopeFrontmatter): string {
  const data = JSON.parse(JSON.stringify(fm)) as Record<string, unknown>
  const lines = [
    `Sent for signature: ${fm.source.name}`,
    '',
    ...fm.signers.map(
      (s) => `- ${s.name} <${s.email}>: ${s.status}${s.signed_at ? ` ${s.signed_at}` : ''}`,
    ),
    '',
    ...fm.audit.map((a) => `- ${a.at} ${a.event}${a.email ? ` by ${a.email}` : ''}`),
  ]
  return `---\n${toYaml(data, { lineWidth: 0 })}---\n${lines.join('\n')}\n`
}

function badInput(issue: { path: PropertyKey[]; message: string } | undefined) {
  return new HotsauceError(
    'bad_request',
    `${issue?.path.map(String).join('.') || 'envelope'}: ${issue?.message ?? 'not valid'}`,
  )
}

const notFound = () => new HotsauceError('not_found', 'No such envelope')
const changed = () =>
  new HotsauceError('conflict', 'The PDF in Files changed since this envelope was made from it')
const stale = () =>
  new HotsauceError('conflict', 'Someone changed this envelope at the same time; reload to see it')
