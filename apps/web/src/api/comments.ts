// Client for `/api/comments` (ARCHITECTURE §27.3): the conversation under a team item.

import { request } from './client'

export interface CommentMention {
  email: string
  name: string
}

export interface Comment {
  id: string
  /** The `id` of the item it is under. */
  item: string
  author: string
  name: string
  created: string
  edited: string | null
  text: string
  /** The passage of the doc it is about, when one was quoted. */
  quote: string | null
  mentions: CommentMention[]
  /** The AI tool it was written through, when there was one. */
  via: string | null
  mine: boolean
  canEdit: boolean
  canDelete: boolean
}

export interface CommentsView {
  /** False for an item that takes no comments: a personal one, or a kind not covered yet. */
  canComment: boolean
  comments: Comment[]
}

export interface CommentMember {
  email: string
  name: string
  handle: string
}

const BASE = '/api/comments'
const enc = encodeURIComponent

export const commentsApi = {
  list: (space: string, path: string) => request<CommentsView>(BASE, { query: { space, path } }),
  members: () => request<{ members: CommentMember[] }>(`${BASE}/members`),
  add: (space: string, path: string, text: string, quote?: string | null) =>
    request<Comment>(BASE, {
      method: 'POST',
      json: quote ? { space, path, text, quote } : { space, path, text },
    }),
  edit: (comment: Pick<Comment, 'item' | 'id'>, text: string) =>
    request<Comment>(`${BASE}/${enc(comment.item)}/${enc(comment.id)}`, {
      method: 'PATCH',
      json: { text },
    }),
  remove: (comment: Pick<Comment, 'item' | 'id'>) =>
    request<void>(`${BASE}/${enc(comment.item)}/${enc(comment.id)}`, { method: 'DELETE' }),
}
