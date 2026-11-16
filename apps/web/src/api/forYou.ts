// Client for `/api/for-you` (ARCHITECTURE §27.5): what is waiting on the member, and their marks.

import { request } from './client'

export interface ForYouItem {
  /** The item's `id`: what marks are kept under. */
  item: string
  space: string
  path: string
  title: string
  kind: string
  /** Opens the item at the newest comment that names the member. */
  url: string
  comment: { id: string; author: string; name: string; text: string; created: string }
  /** How many comments on the item name the member. */
  mentions: number
  /** When it last moved for the member. Newest first. */
  at: string
  /** True until they open it after it last moved. */
  unseen: boolean
}

export interface ForYouView {
  items: ForYouItem[]
  unseen: number
  /** False when the member has no personal space to keep marks in. */
  canMark: boolean
}

export type ForYouMark =
  | { action: 'seen' | 'done' | 'undone' }
  | { action: 'later'; when: 'tomorrow' | 'monday'; zone: string }

const BASE = '/api/for-you'

export const forYouApi = {
  list: () => request<ForYouView>(BASE),
  mark: (item: string, mark: ForYouMark) =>
    request<ForYouView>(`${BASE}/${encodeURIComponent(item)}`, { method: 'POST', json: mark }),
}
