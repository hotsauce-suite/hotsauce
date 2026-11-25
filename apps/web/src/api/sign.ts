// Client for Sign (docs/PLAN-sign.md): envelopes at `/api/sign`, made from a PDF in Files.

import type {
  AuditEntry,
  EnvelopeStatus,
  SavedMark,
  SavedSignatures,
  Signer,
  SignField,
  SignSource,
} from '@hotsauce/format'
import { request, requestBlob } from './client'

export type {
  AuditEntry,
  EnvelopeStatus,
  SavedMark,
  SavedSignatures,
  Signer,
  SignField,
  SignFieldType,
} from '@hotsauce/format'

export interface EnvelopeSummary {
  space: string
  id: string
  title: string
  status: EnvelopeStatus
  sourceName: string
  signers: Array<Pick<Signer, 'name' | 'email' | 'status'>>
  created: string
  createdBy: string
  updated: string | null
  completed: string | null
}

/** A signer as the sender sees them; the link's secret never leaves the server. */
export type SignerView = Omit<Signer, 'token_hash'> & { linkActive: boolean }

/** Who is on a draft, as the sender edits them. */
export type DraftPerson = Pick<Signer, 'id' | 'name' | 'email' | 'order' | 'role'>

export type SigningOrder = 'parallel' | 'sequential'

export interface EnvelopeView extends EnvelopeSummary {
  source: SignSource
  signerList: SignerView[]
  fields: SignField[]
  audit: AuditEntry[]
  auditIntact: boolean
  result: { space: string; signedFile: string; certificateFile: string } | null
  canSign: boolean
  /** Whether the server emails signing links; without it the sender copies them. */
  canEmail: boolean
  /** The ids of the people who can sign now. */
  upNext: string[]
  signingOrder: SigningOrder
  blobOid: string
}

/** A signing link made for someone, shown once to the sender. */
export interface SigningLink {
  signer: string
  name: string
  email: string
  url: string
  emailed: boolean
}

/** What someone outside the team sees from their signing link. */
export interface PublicEnvelope {
  title: string
  sender: string
  org: string
  signer: { id: string; name: string; email: string }
  source: { name: string; pages: SignSource['pages'] }
  fields: SignField[]
  status: 'ready' | 'signed' | 'declined' | 'completed' | 'voided'
}

/** What a signer typed, drew or ticked, by field id. */
export interface FilledValue {
  field: string
  value?: string
  checked?: boolean
  image?: string
  /** How a signature was made; an image without it counts as drawn. */
  input?: 'typed' | 'drawn' | 'uploaded'
}

export type MarkKind = 'signature' | 'initials'

/** A signature or initials to save for next time. */
export type MarkInput =
  | { input: 'typed'; value: string }
  | { input: 'drawn' | 'uploaded'; image: string }

/** The member's saved signature and initials (docs/PLAN-sign-saved-signature.md R5). */
export const savedSignatureApi = {
  get: () => request<SavedSignatures>('/api/sign-saved'),
  save: (kind: MarkKind, mark: MarkInput) =>
    request<SavedSignatures>(`/api/sign-saved/${kind}`, { method: 'PUT', json: mark }),
  remove: (kind: MarkKind) =>
    request<SavedSignatures>(`/api/sign-saved/${kind}`, { method: 'DELETE' }),
}

/** A saved mark as what goes on a field. */
export function markValue(m: SavedMark): Omit<FilledValue, 'field'> {
  return m.input === 'typed'
    ? { value: m.value, input: 'typed' }
    : { image: m.image, input: m.input }
}

const enc = encodeURIComponent
const at = (space: string, id: string) => `/api/sign/${enc(space)}/${enc(id)}`

export const signApi = {
  list: () => request<{ envelopes: EnvelopeSummary[] }>('/api/sign'),
  create: (fileSpace: string, fileId: string) =>
    request<EnvelopeView>('/api/sign', { method: 'POST', json: { fileSpace, fileId } }),
  get: (space: string, id: string) => request<EnvelopeView>(at(space, id)),
  saveDraft: (
    space: string,
    id: string,
    input: {
      title: string
      fields: SignField[]
      signers?: DraftPerson[]
      signingOrder?: SigningOrder
      blobOid: string
    },
  ) => request<EnvelopeView>(at(space, id), { method: 'PUT', json: input }),
  /** Sends a draft: each person up first gets their own link, emailed when the server can. */
  send: (space: string, id: string, blobOid: string) =>
    request<EnvelopeView & { links: SigningLink[] }>(`${at(space, id)}/send`, {
      method: 'POST',
      json: { blobOid },
    }),
  /** A fresh link for someone still to sign; their old one stops working. */
  link: (space: string, id: string, signer: string, email: boolean) =>
    request<SigningLink>(`${at(space, id)}/link/${enc(signer)}`, {
      method: 'POST',
      json: { email },
    }),
  /** Fixes someone's name or email after sending; whoever is up gets a fresh link. */
  correct: (space: string, id: string, signer: string, input: { name: string; email: string }) =>
    request<EnvelopeView & { link: SigningLink | null }>(`${at(space, id)}/people/${enc(signer)}`, {
      method: 'PATCH',
      json: input,
    }),
  /** A new draft with the same PDF, people and field places, nothing filled in. */
  copy: (space: string, id: string) =>
    request<EnvelopeView>(`${at(space, id)}/copy`, { method: 'POST' }),
  sign: (
    space: string,
    id: string,
    input: { values: FilledValue[]; consent: boolean; blobOid: string },
  ) => request<EnvelopeView>(`${at(space, id)}/sign`, { method: 'POST', json: input }),
  remove: (space: string, id: string) => request<void>(at(space, id), { method: 'DELETE' }),
  /** The PDF the envelope was made from, for drawing its pages. */
  source: async (space: string, id: string): Promise<ArrayBuffer> =>
    (await requestBlob(`${at(space, id)}/source.pdf`)).arrayBuffer(),
}

const link = (token: string) => `/api/sign-link/${enc(token)}`

/** The signing page people outside the team open from their emailed link (no account). */
export const signLinkApi = {
  get: (token: string) => request<PublicEnvelope>(link(token)),
  source: async (token: string): Promise<ArrayBuffer> =>
    (await requestBlob(`${link(token)}/source.pdf`)).arrayBuffer(),
  sign: (token: string, input: { values: FilledValue[]; consent: boolean }) =>
    request<PublicEnvelope>(`${link(token)}/sign`, { method: 'POST', json: input }),
  decline: (token: string, reason: string) =>
    request<PublicEnvelope>(`${link(token)}/decline`, { method: 'POST', json: { reason } }),
}
