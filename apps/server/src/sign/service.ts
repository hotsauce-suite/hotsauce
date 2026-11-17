// Hotsauce Sign (docs/PLAN-sign.md): an envelope is `sign/<id>.md`, in the sender's personal space
// unless they share it. Its frontmatter is the truth: the PDF it was made from (a Files id and that
// PDF's SHA-256), the signers, the fields placed on the pages and the audit trail as a hash chain.
// When the last signer signs, the engine (@hotsauce/sign) stamps the fields, seals the PDF and makes
// an audit certificate; both are saved into Files beside the original.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  type AuditEntry,
  EnvelopeFrontmatter,
  envelopePath,
  envelopeProblem,
  isEnvelopeId,
  MAX_DECLINE_REASON,
  MAX_SIGN_PAGES,
  MAX_SIGN_PDF_BYTES,
  parseFrontmatter,
  parseSigningToken,
  SIGNING_LINK_DAYS,
  Signer,
  type SignField,
  SPACE_LAYOUT,
  signersUpNext,
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
import type { Mailer } from '../mail/index.js'
import type { SpaceService } from '../spaces/index.js'
import type { Syncer } from '../sync/index.js'
import { completedEmail, declinedEmail, signingLinkEmail } from './emails.js'

/** The finished PDFs go as attachments up to this size together. */
const MAX_ATTACH_BYTES = 20 * 1024 * 1024

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
  signerList: SignerView[]
  fields: SignField[]
  audit: AuditEntry[]
  /** Whether the audit trail's hash chain checks out. */
  auditIntact: boolean
  /** The sealed PDF and certificate in Files, once finished. */
  result: { space: string; signedFile: string; certificateFile: string } | null
  /** Whether the member reading this is a signer who still has to sign. */
  canSign: boolean
  /** Whether this server emails signing links; without it the sender copies them. */
  canEmail: boolean
  /** The ids of the people who can sign now. */
  upNext: string[]
  /** All at once, or one after another. */
  signingOrder: EnvelopeFrontmatter['signing_order']
  blobOid: string
}

/** A signer as the sender sees them: their link's secret hash stays on the server. */
export type SignerView = Omit<Signer, 'token_hash'> & { linkActive: boolean }

/** A signing link made for someone, shown once to the sender. */
export interface SigningLink {
  signer: string
  name: string
  email: string
  url: string
  emailed: boolean
}

/** What a signer with a link sees: their fields only, and nothing about the others' links. */
export interface PublicEnvelope {
  title: string
  sender: string
  org: string
  signer: { id: string; name: string; email: string }
  source: { name: string; pages: EnvelopeFrontmatter['source']['pages'] }
  fields: SignField[]
  status: 'ready' | 'signed' | 'declined' | 'completed' | 'voided'
}

export interface DraftInput {
  title: string
  /** Checked in full by the format's schema. */
  fields: unknown[]
  /** The people on it: `{ id, name, email, order, role }`; unchanged when left out. */
  signers?: unknown[] | undefined
  signingOrder?: 'parallel' | 'sequential' | undefined
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
  files: Pick<Files, 'get' | 'peek' | 'bytes' | 'storeFormFile' | 'available' | 'removeStored'>
  /** The install's seal key, made on first use (state/seal-key.ts). */
  sealKey: () => SealIdentity
  /** Shown in a PDF reader's signature panel: the organization, else the product. */
  orgName: string
  productName: string
  /** Sends signing links and finished copies (R12). */
  mailer: Mailer
  /** The server's public address, for signing links. */
  publicUrl: string
  log?: (message: string) => void
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
    // People are only named in a draft: their status, links and times start when it's sent.
    const signers = input.signers
      ? input.signers.map((p) =>
          p && typeof p === 'object'
            ? Object.fromEntries(
                Object.entries(p).filter(([k]) =>
                  ['id', 'name', 'email', 'order', 'role'].includes(k),
                ),
              )
            : p,
        )
      : fm.signers
    const parsed = EnvelopeFrontmatter.safeParse({
      ...fm,
      title: input.title.replace(/\s+/g, ' ').trim(),
      signers,
      signing_order: input.signingOrder ?? fm.signing_order,
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
   * Sends a draft: each signer who can sign now gets their own link, by email when this server
   * has a mailer (R11–R13). The links come back once, so the sender can copy them; only their
   * hashes are kept. The sender, if they sign too, signs in the app instead.
   */
  async send(
    principal: Principal,
    space: string,
    id: string,
    input: { blobOid: string },
    meta: RequestMeta,
    via?: string,
  ): Promise<EnvelopeView & { links: SigningLink[] }> {
    this.#assertAccess(principal, space)
    return this.#serial(space, id, async () => {
      const { fm, blobOid } = await this.#read(space, id)
      this.#assertSender(principal, fm)
      if (fm.status !== 'draft') {
        throw new HotsauceError('conflict', 'This envelope has already been sent')
      }
      if (blobOid !== input.blobOid) {
        throw new HotsauceError('conflict', 'This envelope changed since you opened it; reload it')
      }
      const problem = envelopeProblem(fm)
      if (problem) throw new HotsauceError('bad_request', problem)
      const now = this.#iso()
      let next: EnvelopeFrontmatter = { ...fm, status: 'sent', sent: now, updated: now }
      next = {
        ...next,
        audit: chain(fm.id, fm.audit, [
          {
            event: 'sent',
            actor: 'sender',
            email: principal.email,
            ip: meta.ip,
            agent: meta.agent,
            meta: {
              to: fm.signers.filter((s) => s.role !== 'copy').map((s) => s.email),
              copies: fm.signers.filter((s) => s.role === 'copy').map((s) => s.email),
              order: fm.signing_order,
            },
            at: now,
          },
        ]),
      }
      const { fm: withLinks, links } = this.#issueLinks(next, fm.created_by)
      await this.#save(space, principal, withLinks, blobOid, 'send', via)
      const sent = await this.#emailLinks(withLinks, links)
      return { ...(await this.get(principal, space, id)), links: sent }
    })
  }

  /**
   * A fresh link for one signer still to sign (the old one stops working), emailed when this
   * server can and `email` is set; the link comes back for the sender to copy.
   */
  async link(
    principal: Principal,
    space: string,
    id: string,
    signerId: string,
    input: { email: boolean },
    via?: string,
  ): Promise<SigningLink> {
    this.#assertAccess(principal, space)
    return this.#serial(space, id, async () => {
      const { fm, blobOid } = await this.#read(space, id)
      this.#assertSender(principal, fm)
      if (fm.status !== 'sent') {
        throw new HotsauceError('conflict', 'Links work only while the envelope is out for signing')
      }
      const signer = fm.signers.find((s) => s.id === signerId)
      if (!signer || signer.role === 'copy') throw new HotsauceError('not_found', 'No such signer')
      if (signer.status !== 'pending') {
        throw new HotsauceError('conflict', `${signer.name} has already answered`)
      }
      if (!signersUpNext(fm.signers, fm.signing_order).some((s) => s.id === signer.id)) {
        throw new HotsauceError('conflict', `It isn’t ${signer.name}’s turn to sign yet`)
      }
      const made = this.#makeLink(fm, signer)
      const now = this.#iso()
      // A new link is part of the record: who made it, for whom, and whether it was emailed.
      const next: EnvelopeFrontmatter = {
        ...fm,
        signers: fm.signers.map((s) => (s.id === signer.id ? made.signer : s)),
        audit: chain(fm.id, fm.audit, [
          {
            event: 'sent',
            actor: 'sender',
            email: principal.email,
            ip: null,
            agent: null,
            meta: { to: [signer.email], newLink: true, emailed: input.email },
            at: now,
          },
        ]),
        updated: now,
      }
      await this.#save(space, principal, next, blobOid, 'edit', via)
      const [sent] = input.email ? await this.#emailLinks(next, [made.link], true) : [made.link]
      return sent ?? made.link
    })
  }

  /**
   * The member signs their fields in the app: a draft only they sign, or a sent envelope when it
   * is their turn. When nobody is left to sign, the sealed PDF and its certificate are saved into
   * Files beside the original and everyone on it gets a copy.
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
    await this.#serial(space, id, async () => {
      const { fm, blobOid } = await this.#read(space, id)
      if (blobOid !== input.blobOid) {
        throw new HotsauceError('conflict', 'This envelope changed since you opened it; reload it')
      }
      const signer = fm.signers.find(
        (s) => s.email === principal.email.toLowerCase() && s.role !== 'copy',
      )
      if (!signer) throw new HotsauceError('forbidden', 'You aren’t a signer of this envelope')
      if (
        fm.status === 'draft' &&
        fm.signers.some((s) => s.role !== 'copy' && s.id !== signer.id)
      ) {
        throw new HotsauceError('conflict', 'Send it first: other people sign it too')
      }
      await this.#signAs(space, fm, blobOid, signer, input, meta, {
        method: 'Signed in to Hotsauce',
        author: principal,
        via,
      })
    })
    return this.get(principal, space, id)
  }

  /**
   * The sender fixes the name or email of someone who hasn't answered yet, while it's out (R19–R23).
   * If it's their turn, their old link stops and a fresh one goes to the new address; when this
   * server emails, the email goes first and a failure changes nothing (no event, old link works).
   */
  async correct(
    principal: Principal,
    space: string,
    id: string,
    signerId: string,
    input: { name?: string | undefined; email?: string | undefined },
    meta: RequestMeta,
    via?: string,
  ): Promise<EnvelopeView & { link: SigningLink | null }> {
    this.#assertAccess(principal, space)
    return this.#serial(space, id, async () => {
      const { fm, blobOid } = await this.#read(space, id)
      this.#assertSender(principal, fm)
      if (fm.status !== 'sent') {
        throw new HotsauceError(
          'conflict',
          'Only an envelope that’s out for signing can have someone corrected',
        )
      }
      const signer = fm.signers.find((s) => s.id === signerId)
      if (!signer) throw new HotsauceError('not_found', 'No such person on this envelope')
      if (signer.status === 'signed') {
        throw new HotsauceError(
          'conflict',
          `${signer.name} has already signed, so can’t be changed`,
        )
      }
      if (signer.status === 'declined') {
        throw new HotsauceError('conflict', `${signer.name} has declined, so can’t be changed`)
      }
      const name = (input.name ?? signer.name).replace(/\s+/g, ' ').trim().slice(0, 120)
      const email = (input.email ?? signer.email).trim().toLowerCase()
      const check = Signer.shape.email.safeParse(email)
      if (!check.success || !name) {
        throw new HotsauceError(
          'bad_request',
          name ? 'That email address isn’t valid' : 'Add a name',
        )
      }
      if (name === signer.name && email === signer.email) {
        return { ...this.#view(principal, space, fm, blobOid), link: null }
      }
      if (fm.signers.some((s) => s.id !== signer.id && s.email === email)) {
        throw new HotsauceError('bad_request', `${email} is already on this envelope`)
      }
      const now = this.#iso()
      // The corrected person starts fresh: no old link, and no "opened" from the old address.
      const { token_hash, token_expires, sent_at, viewed_at, ...rest } = signer
      let corrected: Signer = { ...rest, name, email }
      let link: SigningLink | null = null
      const isSender = email === fm.created_by.toLowerCase()
      const turn = signersUpNext(fm.signers, fm.signing_order).some((s) => s.id === signer.id)
      if (signer.role !== 'copy' && turn && !isSender) {
        const made = this.#makeLink(fm, corrected)
        corrected = made.signer
        link = made.link
      }
      let next: EnvelopeFrontmatter = {
        ...fm,
        signers: fm.signers.map((s) => (s.id === signer.id ? corrected : s)),
        updated: now,
      }
      if (link && this.#deps.mailer.available) {
        const [mailed] = await this.#emailLinks(next, [link])
        if (!mailed?.emailed) {
          throw new HotsauceError(
            'host_error',
            `The new link couldn’t be emailed to ${email}, so nothing changed. Try again in a minute.`,
          )
        }
        link = mailed
      }
      next = {
        ...next,
        audit: chain(fm.id, fm.audit, [
          {
            event: 'signer_corrected',
            actor: 'sender',
            email: principal.email,
            ip: meta.ip,
            agent: meta.agent,
            meta: {
              signerId: signer.id,
              signerOrder: signer.order,
              previousName: signer.name,
              previousEmail: signer.email,
              signerName: name,
              signerEmail: email,
              newLink: link !== null,
              emailed: link?.emailed ?? false,
            },
            at: now,
          },
        ]),
      }
      // The email went first, so a save that fails now (a rare clash with a change made outside
      // the app) leaves the new address holding a link that doesn't work yet: say so plainly.
      await this.#save(space, principal, next, blobOid, 'edit', via).catch((err) => {
        if (link?.emailed) {
          this.#deps.log?.(`sign: correction emailed but not saved: ${err}`)
          throw new HotsauceError(
            'conflict',
            `The envelope changed while saving, so the link just emailed to ${email} won’t work. Reload and change them again.`,
          )
        }
        throw err
      })
      return { ...(await this.get(principal, space, id)), link }
    })
  }

  /**
   * A new draft from an envelope that has been sent (R24): the same PDF, title, people, order
   * and field places, with nothing filled in. Kept in the same space; whoever copies it sends it.
   */
  async copy(principal: Principal, space: string, id: string, via?: string): Promise<EnvelopeView> {
    this.#assertAccess(principal, space)
    const { fm } = await this.#read(space, id)
    if (fm.status === 'draft') {
      throw new HotsauceError('conflict', 'A draft can’t be copied; edit it instead')
    }
    this.#assertAccess(principal, fm.source.space)
    const original = await this.#deps.files.peek(fm.source.space, fm.source.file)
    if (!original) {
      throw new HotsauceError(
        'not_found',
        'The PDF this was made from is gone from Files, so it can’t be copied',
      )
    }
    // Refused when the PDF in Files changed since.
    await this.#sourceBytes(fm.source.space, fm.source.file, fm.source.sha256)
    const newId = ulid()
    const now = this.#iso()
    const copy = EnvelopeFrontmatter.parse({
      id: newId,
      type: 'envelope',
      title: fm.title,
      status: 'draft',
      signing_order: fm.signing_order,
      source: fm.source,
      signers: fm.signers.map((s) => ({
        id: s.id,
        name: s.name,
        email: s.email,
        order: s.order,
        role: s.role,
      })),
      fields: fm.fields.map(stripFilled),
      created: now,
      created_by: principal.email,
      updated: now,
      audit: chain(
        newId,
        [],
        [
          {
            event: 'copied',
            actor: 'sender',
            email: principal.email,
            meta: { from: fm.id, file: fm.source.name, sha256: fm.source.sha256 },
            at: now,
          },
        ],
      ),
    })
    await this.#commit(space, principal, {
      changes: [{ path: envelopePath(newId), content: envelopeFile(copy) }],
      verb: 'create',
      title: copy.title,
      via,
      unchanged: { path: envelopePath(newId), blobOid: null },
    })
    return this.get(principal, space, newId)
  }

  // ── signing from a link (no account) ─────────────────────────────────

  /** What the link's signer sees; the first look is recorded as viewed (R14, R15). */
  async publicView(token: string, meta: RequestMeta): Promise<PublicEnvelope> {
    const found = await this.#byToken(token)
    const { space, fm, signer } = found
    if (fm.status === 'sent' && signer.status === 'pending' && !signer.viewed_at) {
      await this.#serial(space, fm.id, async () => {
        const fresh = await this.#byToken(token)
        if (fresh.signer.viewed_at || fresh.fm.status !== 'sent') return
        const now = this.#iso()
        const next: EnvelopeFrontmatter = {
          ...fresh.fm,
          signers: fresh.fm.signers.map((s) => (s.id === signer.id ? { ...s, viewed_at: now } : s)),
          audit: chain(fresh.fm.id, fresh.fm.audit, [
            {
              event: 'viewed',
              actor: 'signer',
              email: signer.email,
              ip: meta.ip,
              agent: meta.agent,
              meta: { signerId: signer.id, signerName: signer.name },
              at: now,
            },
          ]),
        }
        await this.#save(space, authorOf(signer), next, fresh.blobOid, 'view')
      })
    }
    const status =
      fm.status === 'completed'
        ? 'completed'
        : fm.status === 'voided'
          ? 'voided'
          : signer.status === 'signed'
            ? 'signed'
            : signer.status === 'declined' || fm.status === 'declined'
              ? 'declined'
              : 'ready'
    return {
      title: fm.title,
      sender: this.#senderName(fm),
      org: this.#deps.orgName,
      signer: { id: signer.id, name: signer.name, email: signer.email },
      source: { name: fm.source.name, pages: fm.source.pages },
      fields: fm.fields
        .filter((f) => f.signer === signer.id)
        .map((f) => (status === 'ready' ? stripFilled(f) : f)),
      status,
    }
  }

  /** The PDF, for the link's signer to read while it's theirs to sign. */
  async publicSource(token: string): Promise<Uint8Array> {
    const { fm, signer } = await this.#byToken(token)
    if (fm.status !== 'sent' || signer.status !== 'pending') {
      throw new HotsauceError('conflict', 'This document isn’t waiting for your signature')
    }
    return this.#sourceBytes(fm.source.space, fm.source.file, fm.source.sha256)
  }

  /** The link's signer signs (R14). */
  async publicSign(
    token: string,
    input: { values: FilledValue[]; consent: boolean },
    meta: RequestMeta,
  ): Promise<PublicEnvelope> {
    const first = await this.#byToken(token)
    await this.#serial(first.space, first.fm.id, async () => {
      const { space, fm, signer, blobOid } = await this.#byToken(token)
      if (fm.status !== 'sent') {
        throw new HotsauceError('conflict', 'This document isn’t out for signing any more')
      }
      await this.#signAs(space, fm, blobOid, signer, input, meta, {
        method: 'Email link',
        author: authorOf(signer),
      })
    })
    return this.publicView(token, meta)
  }

  /** The link's signer declines; the envelope stops and the sender is told (R16). */
  async publicDecline(
    token: string,
    input: { reason: string },
    meta: RequestMeta,
  ): Promise<PublicEnvelope> {
    const first = await this.#byToken(token)
    await this.#serial(first.space, first.fm.id, async () => {
      const { space, fm, signer, blobOid } = await this.#byToken(token)
      if (fm.status !== 'sent' || signer.status !== 'pending') {
        throw new HotsauceError('conflict', 'This document isn’t waiting for your answer')
      }
      const reason = input.reason.replace(/\s+/g, ' ').trim().slice(0, MAX_DECLINE_REASON)
      const now = this.#iso()
      const next: EnvelopeFrontmatter = {
        ...fm,
        status: 'declined',
        declined: now,
        updated: now,
        signers: fm.signers.map((s) =>
          s.id === signer.id
            ? {
                ...s,
                status: 'declined' as const,
                declined_at: now,
                ...(reason ? { decline_reason: reason } : {}),
              }
            : s,
        ),
        audit: chain(fm.id, fm.audit, [
          {
            event: 'declined',
            actor: 'signer',
            email: signer.email,
            ip: meta.ip,
            agent: meta.agent,
            meta: { signerId: signer.id, signerName: signer.name, reason: reason || null },
            at: now,
          },
        ]),
      }
      await this.#save(space, authorOf(signer), next, blobOid, 'decline')
      const mail = declinedEmail({
        signer: signer.name,
        title: fm.title,
        reason: reason || null,
        url: `${this.#deps.publicUrl}/sign/${encodeURIComponent(space)}/${fm.id}`,
      })
      await this.#mail({ to: fm.created_by, fromName: this.#deps.productName, ...mail })
    })
    return this.publicView(token, meta)
  }

  /** Runs one change to an envelope at a time, so two presses can't both seal a copy. */
  async #serial<T>(space: string, id: string, fn: () => Promise<T>): Promise<T> {
    const key = `${space}/${id}`
    const before = this.#signing.get(key) ?? Promise.resolve()
    const run = before.then(fn)
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

  /** One signer signs: fills their fields, chains the audit, and completes or passes it on. */
  async #signAs(
    space: string,
    fm: EnvelopeFrontmatter,
    blobOid: string,
    signer: Signer,
    input: { values: FilledValue[]; consent: boolean },
    meta: RequestMeta,
    how: { method: string; author: Author; via?: string | undefined },
  ): Promise<void> {
    if (fm.status !== 'draft' && fm.status !== 'sent') {
      throw new HotsauceError('conflict', 'This envelope is finished; nothing is left to sign')
    }
    if (signer.status !== 'pending') {
      throw new HotsauceError('conflict', 'You have already signed this envelope')
    }
    if (
      fm.status === 'sent' &&
      !signersUpNext(fm.signers, fm.signing_order).some((s) => s.id === signer.id)
    ) {
      throw new HotsauceError('conflict', 'It isn’t your turn to sign yet')
    }
    if (!input.consent) {
      throw new HotsauceError('bad_request', 'Agree to sign electronically first')
    }
    const problem = envelopeProblem(fm)
    if (problem) throw new HotsauceError('bad_request', problem)

    const now = this.#iso()
    const fields = fillFields(fm.fields, signer.id, input.values, now)
    const signers = fm.signers.map((s) =>
      s.id === signer.id
        ? {
            ...s,
            status: 'signed' as const,
            signed_at: now,
          }
        : s,
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
          // How they were checked: signed in to Hotsauce, or holding their own emailed link.
          method: how.method,
          // What they filled in, so an edit to the fields afterwards breaks the audit check.
          fieldsSha256: filledDigest(fields, signer.id),
        },
      },
    ])
    let next: EnvelopeFrontmatter = { ...fm, fields, signers, audit, updated: now }
    const done = signers.every((s) => s.role === 'copy' || s.status === 'signed')
    let links: SigningLink[] = []
    if (done) {
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
    } else if (next.status === 'sent') {
      // In order, the next people up get their links now.
      const issued = this.#issueLinks(next, next.created_by)
      next = issued.fm
      links = issued.links
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
    const author = { name: how.author.name, email: how.author.email }
    let sealed: { signed: Uint8Array; certificate: Uint8Array } | null = null
    try {
      if (next.status === 'completed') {
        const made = await this.#finish(author, next, stored)
        next = { ...next, result: made.result }
        sealed = made
      }
      await this.#save(space, how.author, next, blobOid, 'sign', how.via)
    } catch (err) {
      // Nothing points at copies sealed for a sign that didn't land: take them back out.
      for (const fileId of stored) {
        await this.#deps.files.removeStored(author, fm.source.space, fileId).catch(() => undefined)
      }
      throw err
    }
    // Email doesn't hold up the signer (several slow sends could time their page out): it goes
    // out after the envelope is saved, and a failure is only logged.
    const after = next
    if (sealed) this.#background(this.#emailCopies(after, sealed))
    else if (links.length) this.#background(this.#emailLinks(after, links))
  }

  /** Emails sent after the response; tests wait for them with `settled()`. */
  #pending = new Set<Promise<unknown>>()
  #background(p: Promise<unknown>): void {
    const tracked = p.catch((err) => this.#deps.log?.(`sign: email failed: ${err}`))
    this.#pending.add(tracked)
    void tracked.finally(() => this.#pending.delete(tracked))
  }

  /** Waits for emails still going out (tests, and a clean shutdown). */
  async settled(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all([...this.#pending])
  }

  #assertSender(principal: Principal, fm: EnvelopeFrontmatter): void {
    if (principal.email.toLowerCase() !== fm.created_by.toLowerCase()) {
      throw new HotsauceError('forbidden', 'Only the person who made this envelope can send it')
    }
  }

  /** Gives every signer up next who has no working link a fresh one (not `skip`, the sender). */
  #issueLinks(
    fm: EnvelopeFrontmatter,
    skip: string | null,
  ): { fm: EnvelopeFrontmatter; links: SigningLink[] } {
    const links: SigningLink[] = []
    const now = this.#now().getTime()
    let signers = fm.signers
    for (const s of signersUpNext(fm.signers, fm.signing_order)) {
      if (skip && s.email === skip.toLowerCase()) continue
      if (s.token_hash && s.token_expires && Date.parse(s.token_expires) > now) continue
      const made = this.#makeLink(fm, s)
      signers = signers.map((x) => (x.id === s.id ? made.signer : x))
      links.push(made.link)
    }
    return { fm: { ...fm, signers }, links }
  }

  #makeLink(fm: EnvelopeFrontmatter, s: Signer): { signer: Signer; link: SigningLink } {
    const secret = randomBytes(32).toString('base64url')
    const expires = new Date(this.#now().getTime() + SIGNING_LINK_DAYS * 86_400_000)
    return {
      signer: {
        ...s,
        token_hash: sha256(secret),
        token_expires: expires.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        sent_at: this.#iso(),
      },
      link: {
        signer: s.id,
        name: s.name,
        email: s.email,
        url: `${this.#deps.publicUrl}/signing/${fm.id}.${s.id}.${secret}`,
        emailed: false,
      },
    }
  }

  /** Emails each link, when this server can; says which were sent. */
  async #emailLinks(
    fm: EnvelopeFrontmatter,
    links: SigningLink[],
    reminder = false,
  ): Promise<SigningLink[]> {
    if (!this.#deps.mailer.available) return links
    const out: SigningLink[] = []
    for (const l of links) {
      const signer = fm.signers.find((s) => s.id === l.signer)
      const expires = signer?.token_expires
        ? new Date(signer.token_expires).toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
            timeZone: 'UTC',
          })
        : `${SIGNING_LINK_DAYS} days from now`
      const mail = signingLinkEmail({
        to: l.name,
        sender: this.#senderName(fm),
        org: this.#deps.orgName,
        title: fm.title,
        url: l.url,
        expires,
        reminder,
      })
      const ok = await this.#mail({
        to: l.email,
        fromName: `${this.#senderName(fm)} via ${this.#deps.orgName}`,
        replyTo: fm.created_by,
        ...mail,
      })
      out.push({ ...l, emailed: ok })
    }
    return out
  }

  /** Everyone on it, and the sender, get the sealed PDF and certificate (R16). */
  async #emailCopies(
    fm: EnvelopeFrontmatter,
    sealed: { signed: Uint8Array; certificate: Uint8Array },
  ): Promise<void> {
    if (!this.#deps.mailer.available) return
    const stem = fm.source.name.replace(/\.pdf$/i, '')
    const to = new Map<string, string>()
    for (const s of fm.signers) to.set(s.email, s.name)
    if (!to.has(fm.created_by)) to.set(fm.created_by, this.#senderName(fm))
    // Resend takes about 40 MB a message, base64 included: above this, say so instead of failing.
    const attach = sealed.signed.byteLength + sealed.certificate.byteLength <= MAX_ATTACH_BYTES
    for (const [email, name] of to) {
      const mail = completedEmail({
        to: name,
        title: fm.title,
        org: this.#deps.orgName,
        sender: this.#senderName(fm),
        attached: attach,
      })
      await this.#mail({
        to: email,
        fromName: `${this.#senderName(fm)} via ${this.#deps.orgName}`,
        replyTo: fm.created_by,
        ...mail,
        ...(attach
          ? {
              attachments: [
                { filename: `${stem} (signed).pdf`, content: sealed.signed },
                { filename: `${stem} (certificate).pdf`, content: sealed.certificate },
              ],
            }
          : {}),
      })
    }
  }

  /** Sends one email; a failure is logged, never undoes the signing. */
  async #mail(message: Parameters<Mailer['send']>[0]): Promise<boolean> {
    try {
      await this.#deps.mailer.send(message)
      return true
    } catch (err) {
      this.#deps.log?.(`sign: email to ${message.to} failed: ${err}`)
      return false
    }
  }

  #senderName(fm: EnvelopeFrontmatter): string {
    return fm.signers.find((s) => s.email === fm.created_by)?.name ?? fm.created_by
  }

  /** The envelope and signer a link names, once its secret matches and it hasn't expired. */
  async #byToken(token: string) {
    const bad = () =>
      new HotsauceError(
        'not_found',
        'This signing link doesn’t work. Ask the sender for a new one.',
      )
    const parts = parseSigningToken(token)
    if (!parts) throw bad()
    const space = this.#spaceOf(parts.envelope)
    if (!space) throw bad()
    const { fm, blobOid } = await this.#read(space, parts.envelope).catch(() => {
      throw bad()
    })
    const signer = fm.signers.find((s) => s.id === parts.signer)
    if (!signer || signer.role === 'copy' || !signer.token_hash) throw bad()
    // A replaced link has another hash. One already used still opens, to show what happened.
    if (!safeEqual(signer.token_hash, sha256(parts.secret))) throw bad()
    const open = signer.status === 'pending' && fm.status === 'sent'
    if (open && signer.token_expires && Date.parse(signer.token_expires) < this.#now().getTime()) {
      throw new HotsauceError(
        'conflict',
        'This signing link has expired. Ask the sender for a new one.',
      )
    }
    return { space, fm, signer, blobOid }
  }

  /** Which space holds an envelope, from the index (envelope ids are unique). */
  #spaceOf(id: string): string | null {
    const path = envelopePath(id)
    for (const { name } of this.#deps.index.listSpaces()) {
      if (
        this.#deps.index.listFiles({ space: name, kind: 'envelope' }).some((r) => r.path === path)
      ) {
        return name
      }
    }
    return null
  }

  async #save(
    space: string,
    author: Author,
    fm: EnvelopeFrontmatter,
    blobOid: string,
    verb: string,
    via?: string,
  ): Promise<void> {
    const parsed = EnvelopeFrontmatter.safeParse(fm)
    if (!parsed.success) throw badInput(parsed.error.issues[0])
    await this.#commit(space, author, {
      changes: [{ path: envelopePath(fm.id), content: envelopeFile(parsed.data) }],
      verb,
      title: fm.title,
      via,
      unchanged: { path: envelopePath(fm.id), blobOid },
    })
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
    author: Pick<Principal, 'name' | 'email'>,
    fm: EnvelopeFrontmatter,
    stored: string[],
  ): Promise<{
    result: NonNullable<EnvelopeFrontmatter['result']>
    signed: Uint8Array
    certificate: Uint8Array
  }> {
    const original = await this.#deps.files.peek(fm.source.space, fm.source.file)
    if (!original) {
      throw new HotsauceError('conflict', 'The PDF this was made from is gone from Files')
    }
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
        author,
        { space: fm.source.space, folder: original.folder, name, mime: 'application/pdf', bytes },
        undefined,
      )
    const signedFile = await store(`${stem} (signed).pdf`, signed)
    stored.push(signedFile.id)
    const certificateFile = await store(`${stem} (certificate).pdf`, certificate)
    stored.push(certificateFile.id)
    return {
      result: {
        signed_file: signedFile.id,
        certificate_file: certificateFile.id,
        signed_sha256: signedSha256,
      },
      signed,
      certificate,
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
      signerList: fm.signers.map(({ token_hash, ...s }) => ({
        ...s,
        linkActive:
          Boolean(token_hash) &&
          s.status === 'pending' &&
          Date.parse(s.token_expires ?? '') > this.#now().getTime(),
      })),
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
        me !== undefined &&
        me.role !== 'copy' &&
        me.status === 'pending' &&
        envelopeProblem(fm) === null &&
        (fm.status === 'draft'
          ? !fm.signers.some((s) => s.role !== 'copy' && s.id !== me.id)
          : fm.status === 'sent' &&
            signersUpNext(fm.signers, fm.signing_order).some((s) => s.id === me.id)),
      canEmail: this.#deps.mailer.available,
      upNext:
        fm.status === 'sent' ? signersUpNext(fm.signers, fm.signing_order).map((s) => s.id) : [],
      signingOrder: fm.signing_order,
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
  const emails = new Set<string>()
  for (const s of fm.signers) {
    if (emails.has(s.email)) return `${s.email} is on the list twice`
    emails.add(s.email)
  }
  if (signers.size !== fm.signers.length) return 'Two people have the same id'
  const ids = new Set<string>()
  for (const f of fm.fields) {
    if (ids.has(f.id)) return 'Two fields have the same id'
    ids.add(f.id)
    if (!signers.has(f.signer)) return 'A field belongs to nobody on the list'
    if (fm.signers.find((s) => s.id === f.signer)?.role === 'copy') {
      return 'Someone who only gets a copy can’t have fields'
    }
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

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Commits by a signer with no account carry their name and email. */
function authorOf(s: Pick<Signer, 'name' | 'email'>): Author {
  return { name: s.name, email: s.email }
}

/** A field as placed, before anyone filled it in. */
function stripFilled(f: SignField): SignField {
  const { value, checked, input, image, filled_at, ...rest } = f
  return rest
}
