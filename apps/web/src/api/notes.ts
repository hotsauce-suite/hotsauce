// Client for `/api/notes` (ARCHITECTURE §14.3). NoteView is the server's (§14.2).

import type { KeepNote, NoteColor, NoteSource } from '@hearth/format'
import { request } from './client'

export type { NoteColor, NoteSource }

export interface NoteView {
  space: string
  path: string
  id: string
  blobOid: string
  title: string
  body: string
  checklist: boolean
  color: NoteColor | null
  pinned: boolean
  archived: boolean
  trashed: string | null
  labels: string[]
  created: string
  createdBy: string
  updated: string
  order: number | null
  source: NoteSource | null
}

export type NoteListView = 'board' | 'archive' | 'trash'

export interface NoteInput {
  title?: string
  body?: string
  color?: NoteColor | null
  pinned?: boolean
  archived?: boolean
  labels?: string[]
  order?: number | null
}

export interface NoteLabel {
  name: string
  count: number
}

const BASE = '/api/notes'
const one = (space: string, id: string) =>
  `${BASE}/${encodeURIComponent(space)}/${encodeURIComponent(id)}`

/** `space/id`: a note's identity across spaces. */
export const noteKey = (n: { space: string; id: string }) => `${n.space}/${n.id}`

export const notesApi = {
  list: async (
    filter: {
      view?: NoteListView | undefined
      label?: string | undefined
      q?: string | undefined
    } = {},
  ): Promise<NoteView[]> => {
    const res = await request<{ notes: NoteView[] }>(BASE, {
      query: { view: filter.view, label: filter.label, q: filter.q },
    })
    return Array.isArray(res?.notes) ? res.notes : []
  },

  labels: () => request<NoteLabel[]>(`${BASE}/labels`),

  create: (input: NoteInput & { space?: string }) =>
    request<NoteView>(BASE, { method: 'POST', json: input }),

  get: (space: string, id: string) => request<NoteView>(one(space, id)),

  update: (space: string, id: string, patch: NoteInput & { baseBlobOid?: string }) =>
    request<NoteView>(one(space, id), { method: 'PATCH', json: patch }),

  trash: (space: string, id: string) =>
    request<NoteView>(`${one(space, id)}/trash`, { method: 'POST', json: {} }),

  restore: (space: string, id: string) =>
    request<NoteView>(`${one(space, id)}/restore`, { method: 'POST', json: {} }),

  move: (space: string, id: string, toSpace: string) =>
    request<NoteView>(`${one(space, id)}/move`, { method: 'POST', json: { toSpace } }),

  remove: (space: string, id: string) => request<void>(one(space, id), { method: 'DELETE' }),

  importKeep: (notes: Array<{ ref: string; note: KeepNote }>) =>
    request<{ imported: number; skipped: number }>(`${BASE}/import/keep`, {
      method: 'POST',
      json: { notes },
    }),
}
