import { request } from './client'

/** What the server says about an authorization request before the member presses Allow. */
export interface AuthorizationCheck {
  clientName: string
  clientId: string
  /** Where the app will send the browser back to: shown so the member can recognise it. */
  redirectHost: string
  /**
   * True when the return address is a tool we know (claude.ai, chatgpt.com, grok.com), so the name
   * is a fact; otherwise the name is only what the app calls itself.
   */
  verified: boolean
  /** Where Cancel goes: the app's own address with `error=access_denied`. */
  cancelUrl: string
}

/** An AI tool the member connected by signing in (Settings → Connected apps). */
export interface Connection {
  id: string
  clientName: string
  redirectHost: string
  createdAt: string
  lastUsedAt: string | null
}

export const oauthApi = {
  check: (search: string) =>
    request<AuthorizationCheck>(
      `/api/oauth/authorize${search.startsWith('?') ? search : `?${search}`}`,
    ),
  allow: (search: string) =>
    request<{ redirect: string }>('/api/oauth/authorize', {
      method: 'POST',
      json: Object.fromEntries(new URLSearchParams(search)),
    }),
  connections: () => request<Connection[]>('/api/oauth/connections'),
  disconnect: (id: string) =>
    request<void>(`/api/oauth/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}
