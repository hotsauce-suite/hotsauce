// Client for `/api/themes`: the member's own themes (docs/PLAN-ai-themes.md).

import type { SavedTheme, Theme } from '@hotsauce/format'
import { request } from './client'

export type { SavedTheme, Theme }

export const themesApi = {
  list: () => request<{ themes: SavedTheme[]; canGenerate: boolean }>('/api/themes'),

  /** A theme from a description (refining `base`, the one being previewed). Saves nothing. */
  generate: (prompt: string, base?: Theme) =>
    request<{ theme: Theme }>('/api/themes/generate', {
      method: 'POST',
      json: base ? { prompt, base } : { prompt },
    }),

  save: (input: { name: string; prompt: string; theme: Theme }) =>
    request<{ theme: SavedTheme }>('/api/themes', { method: 'POST', json: input }),

  rename: (id: string, name: string) =>
    request<{ ok: true }>(`/api/themes/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      json: { name },
    }),

  remove: (id: string) =>
    request<{ ok: true }>(`/api/themes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}
