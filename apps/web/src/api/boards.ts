// Client for `/api/boards` (ARCHITECTURE §15.3). The shapes are the server's (§15.2).

import type { BoardScene } from '@hearth/format'
import { request } from './client'

export type { BoardScene }

export interface BoardSummary {
  space: string
  path: string
  id: string
  blobOid: string
  title: string
  created: string
  createdBy: string
  updated: string
  updatedBy: string | null
}

export interface BoardView extends BoardSummary {
  scene: BoardScene
  texts: string[]
}

export const boardsApi = {
  list: (query: { q?: string; space?: string } = {}) =>
    request<{ boards: BoardSummary[] }>('/api/boards', { query }).then((r) => r.boards),
  get: (space: string, id: string) =>
    request<BoardView>(`/api/boards/${encodeURIComponent(space)}/${encodeURIComponent(id)}`),
  create: (input: { title?: string; space?: string }) =>
    request<BoardView>('/api/boards', { method: 'POST', json: input }),
  save: (
    space: string,
    id: string,
    input: { scene?: BoardScene; title?: string; baseBlobOid?: string },
  ) =>
    request<BoardView & { merged: boolean }>(
      `/api/boards/${encodeURIComponent(space)}/${encodeURIComponent(id)}`,
      { method: 'PUT', json: input },
    ),
  remove: (space: string, id: string) =>
    request<void>(`/api/boards/${encodeURIComponent(space)}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
}
