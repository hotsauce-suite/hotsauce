// Client for Hearth Tables (ARCHITECTURE §22): `/api/tables` and a form's answers as a table.

import type { Column } from '@hearth/format'
import { request, requestBlob } from './client'

export type { Column, ColumnType } from '@hearth/format'

export interface TableSummary {
  space: string
  id: string
  title: string
  updated: string | null
  updatedBy: string | null
}

export interface TableView extends TableSummary {
  columns: Column[]
  cells: string[][]
  created: string | null
  createdBy: string | null
  blobOid: string
}

export interface TableInput {
  title: string
  columns: Column[]
  cells: string[][]
  blobOid: string
}

export interface AnswerTable {
  title: string
  columns: Column[]
  cells: string[][]
}

const enc = encodeURIComponent
const at = (space: string, id: string) => `/api/tables/${enc(space)}/${enc(id)}`

export const tablesApi = {
  list: () => request<{ tables: TableSummary[] }>('/api/tables'),
  create: (space: string, title: string) =>
    request<TableView>('/api/tables', { method: 'POST', json: { space, title } }),
  fromForm: (space: string, form: { space: string; id: string }) =>
    request<TableView>('/api/tables', { method: 'POST', json: { space, fromForm: form } }),
  importFile: (space: string, file: File) => {
    const form = new FormData()
    form.set('space', space)
    form.set('file', file)
    return request<TableView>('/api/tables/import', { method: 'POST', form })
  },
  get: (space: string, id: string) => request<TableView>(at(space, id)),
  save: (space: string, id: string, input: TableInput) =>
    request<TableView>(at(space, id), { method: 'PUT', json: input }),
  remove: (space: string, id: string) => request<void>(at(space, id), { method: 'DELETE' }),
  csv: (space: string, id: string) => requestBlob(`${at(space, id)}/csv`),
  xlsx: (space: string, id: string) => requestBlob(`${at(space, id)}/xlsx`),
  formTable: (space: string, id: string) =>
    request<AnswerTable>(`/api/forms/${enc(space)}/${enc(id)}/table`),
}
