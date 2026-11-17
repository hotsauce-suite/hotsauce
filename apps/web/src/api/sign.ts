// Client for Sign (docs/PLAN-sign.md): envelopes at `/api/sign`, made from a PDF in Files.

import type { AuditEntry, EnvelopeStatus, Signer, SignField, SignSource } from '@hotsauce/format'
import { request, requestBlob } from './client'

export type { AuditEntry, EnvelopeStatus, Signer, SignField, SignFieldType } from '@hotsauce/format'

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

export interface EnvelopeView extends EnvelopeSummary {
  source: SignSource
  signerList: Signer[]
  fields: SignField[]
  audit: AuditEntry[]
  auditIntact: boolean
  result: { space: string; signedFile: string; certificateFile: string } | null
  canSign: boolean
  blobOid: string
}

/** What a signer typed, drew or ticked, by field id. */
export interface FilledValue {
  field: string
  value?: string
  checked?: boolean
  image?: string
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
    input: { title: string; fields: SignField[]; blobOid: string },
  ) => request<EnvelopeView>(at(space, id), { method: 'PUT', json: input }),
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
