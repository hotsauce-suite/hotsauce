// Hotsauce Sign (docs/PLAN-sign.md): an envelope is `sign/<id>.md` in the sender's space. Its
// frontmatter holds the PDF it was made from (a Files id and that PDF's SHA-256), the signers,
// the fields placed on the pages, the audit trail as a hash chain, and, once finished, the Files
// ids of the sealed PDF and its certificate. The PDFs themselves are in Files.

import { z } from 'zod'

export const SIGN_FOLDER = 'sign'
export const MAX_SIGNERS = 10
export const MAX_FIELDS = 200
/** The PDF an envelope is made from, at most. */
export const MAX_SIGN_PDF_BYTES = 25 * 1024 * 1024
export const MAX_SIGN_PAGES = 100
/** A drawn signature, as a PNG data URL. */
export const MAX_DRAWN_SIGNATURE_CHARS = 200_000

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/
const FIELD_ID = /^[a-z0-9]{1,16}$/
const SHA256 = /^[0-9a-f]{64}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/

export const envelopePath = (id: string) => `${SIGN_FOLDER}/${id}.md`
export const isEnvelopeId = (id: string) => ULID.test(id)

/** `sign/<id>.md` → the id; anything else null. */
export function envelopeIdOf(path: string): string | null {
  const m = /^sign\/([0-9A-HJKMNP-TV-Z]{26})\.md$/.exec(path)
  return m?.[1] ?? null
}

export const ENVELOPE_STATUSES = ['draft', 'sent', 'completed', 'declined', 'voided'] as const
export type EnvelopeStatus = (typeof ENVELOPE_STATUSES)[number]

export const SIGNER_STATUSES = ['pending', 'signed', 'declined'] as const
/** Someone who signs, or someone who only gets the finished copy. */
export const SIGNER_ROLES = ['signer', 'copy'] as const
export const SIGNING_ORDERS = ['parallel', 'sequential'] as const
/** How long a signing link works. */
export const SIGNING_LINK_DAYS = 30
export const MAX_DECLINE_REASON = 500

/** The field types Sign places today; the engine draws a few more (number, dropdown, radio). */
export const SIGN_FIELD_TYPES = ['signature', 'initials', 'date', 'text', 'checkbox'] as const
export type SignFieldType = (typeof SIGN_FIELD_TYPES)[number]

const unit = z.number().min(0).max(1)

export const SignPage = z.object({
  /** Points (1/72 inch). */
  width: z.number().positive().max(14_400),
  height: z.number().positive().max(14_400),
})
export type SignPage = z.infer<typeof SignPage>

export const SignSource = z.object({
  /** The Files id of the PDF, in `space`. */
  file: z.string().regex(/^[0-9A-Z]{26}$/),
  space: z.string().min(1).max(100),
  name: z.string().min(1).max(255),
  sha256: z.string().regex(SHA256),
  size: z.number().int().positive(),
  pages: z.array(SignPage).min(1).max(MAX_SIGN_PAGES),
})
export type SignSource = z.infer<typeof SignSource>

export const Signer = z.object({
  id: z.string().regex(FIELD_ID),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().max(320).regex(EMAIL),
  order: z.number().int().min(1).max(MAX_SIGNERS),
  role: z.enum(SIGNER_ROLES).default('signer'),
  status: z.enum(SIGNER_STATUSES).default('pending'),
  signed_at: z.string().optional(),
  /** Their signing link: the SHA-256 of its secret (never the secret) and when it stops working. */
  token_hash: z.string().regex(SHA256).optional(),
  token_expires: z.string().optional(),
  sent_at: z.string().optional(),
  viewed_at: z.string().optional(),
  declined_at: z.string().optional(),
  decline_reason: z.string().max(MAX_DECLINE_REASON).optional(),
})
export type Signer = z.infer<typeof Signer>

export const SignField = z
  .object({
    id: z.string().regex(FIELD_ID),
    signer: z.string().regex(FIELD_ID),
    type: z.enum(SIGN_FIELD_TYPES),
    /** 1-based. */
    page: z.number().int().min(1).max(MAX_SIGN_PAGES),
    /** Position and size as fractions of the page, from its top-left corner. */
    x: unit,
    y: unit,
    width: z.number().min(0.01).max(1),
    height: z.number().min(0.005).max(1),
    required: z.boolean().default(true),
    /** Filled in when signed. */
    value: z.string().max(5000).optional(),
    checked: z.boolean().optional(),
    input: z.enum(['typed', 'drawn']).optional(),
    /** A drawn signature or initials. */
    image: z.string().max(MAX_DRAWN_SIGNATURE_CHARS).regex(PNG_DATA_URL).optional(),
    filled_at: z.string().optional(),
  })
  .refine((f) => f.x + f.width <= 1.0001 && f.y + f.height <= 1.0001, {
    message: 'A field must sit inside its page',
  })
export type SignField = z.infer<typeof SignField>

export const AUDIT_EVENTS = [
  'created',
  'sent',
  'viewed',
  'consented',
  'signed',
  'declined',
  'completed',
  /** The sender fixed someone's name or email after sending (meta: the old and new ones). */
  'signer_corrected',
  /** A draft copied from an earlier envelope (meta.from: its id); the copy's first event. */
  'copied',
] as const

/** One audit event, chained to the one before it by `prev` and `hash` (see @hotsauce/sign). */
export const AuditEntry = z.object({
  seq: z.number().int().positive(),
  id: z.string().min(1).max(64),
  /** ISO time. */
  at: z.string(),
  event: z.enum(AUDIT_EVENTS),
  actor: z.enum(['sender', 'signer', 'system']),
  email: z.string().nullable().default(null),
  ip: z.string().max(100).nullable().default(null),
  agent: z.string().max(500).nullable().default(null),
  meta: z.record(z.string(), z.unknown()).nullable().default(null),
  prev: z.string().regex(SHA256).nullable(),
  hash: z.string().regex(SHA256),
})
export type AuditEntry = z.infer<typeof AuditEntry>

export const SignResult = z.object({
  /** Files ids, in the source PDF's space and folder. */
  signed_file: z.string(),
  certificate_file: z.string(),
  signed_sha256: z.string().regex(SHA256),
})

export const EnvelopeFrontmatter = z.looseObject({
  id: z.string().regex(ULID),
  type: z.literal('envelope'),
  title: z.string().trim().min(1).max(200),
  status: z.enum(ENVELOPE_STATUSES),
  /** All at once, or one after another by `order`. */
  signing_order: z.enum(SIGNING_ORDERS).default('parallel'),
  source: SignSource,
  signers: z.array(Signer).min(1).max(MAX_SIGNERS),
  fields: z.array(SignField).max(MAX_FIELDS).default([]),
  audit: z.array(AuditEntry).default([]),
  result: SignResult.optional(),
  created: z.string(),
  created_by: z.string(),
  sent: z.string().optional(),
  completed: z.string().optional(),
  declined: z.string().optional(),
  updated: z.string().optional(),
})
export type EnvelopeFrontmatter = z.infer<typeof EnvelopeFrontmatter>

/**
 * What's wrong with an envelope before it goes out, or null: every signer needs a signature
 * field, every field belongs to a signer and sits on a page the PDF has, and ids are unique.
 */
export function envelopeProblem(
  fm: Pick<EnvelopeFrontmatter, 'source'> & {
    signers: readonly Pick<Signer, 'id' | 'email' | 'name' | 'role'>[]
    fields: readonly Pick<SignField, 'id' | 'signer' | 'page' | 'type'>[]
  },
): string | null {
  const signers = new Set<string>()
  const emails = new Set<string>()
  for (const s of fm.signers) {
    if (signers.has(s.id)) return 'Two signers have the same id'
    if (emails.has(s.email)) return `${s.email} is listed twice`
    signers.add(s.id)
    emails.add(s.email)
  }
  const ids = new Set<string>()
  for (const f of fm.fields) {
    if (ids.has(f.id)) return 'Two fields have the same id'
    ids.add(f.id)
    if (!signers.has(f.signer)) return 'A field belongs to nobody on the list'
    if (f.page > fm.source.pages.length) return `A field is on page ${f.page}, which isn't there`
  }
  const signing = fm.signers.filter((s) => s.role !== 'copy')
  if (signing.length === 0) return 'Add someone to sign'
  for (const f of fm.fields) {
    if (fm.signers.find((s) => s.id === f.signer)?.role === 'copy') {
      return 'Someone who only gets a copy can’t have fields'
    }
  }
  for (const s of signing) {
    if (!fm.fields.some((f) => f.signer === s.id && f.type === 'signature')) {
      return `Add a signature field for ${s.name}`
    }
  }
  return null
}

/** A signing link's token: `<envelope id>.<signer id>.<secret>`; null when it isn't one. */
export function parseSigningToken(
  token: string,
): { envelope: string; signer: string; secret: string } | null {
  const m = /^([0-9A-HJKMNP-TV-Z]{26})\.([a-z0-9]{1,16})\.([A-Za-z0-9_-]{32,64})$/.exec(token)
  if (!m?.[1] || !m[2] || !m[3]) return null
  return { envelope: m[1], signer: m[2], secret: m[3] }
}

/**
 * Who is up to sign now: every pending signer at once, or in order only those with the lowest
 * order still pending. Copy recipients never sign.
 */
export function signersUpNext<T extends Pick<Signer, 'role' | 'status' | 'order'>>(
  signers: readonly T[],
  order: (typeof SIGNING_ORDERS)[number],
): T[] {
  const pending = signers.filter((s) => s.role !== 'copy' && s.status === 'pending')
  if (order === 'parallel' || pending.length === 0) return pending
  const first = Math.min(...pending.map((s) => s.order))
  return pending.filter((s) => s.order === first)
}
