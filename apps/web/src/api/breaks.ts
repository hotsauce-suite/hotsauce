// Client for `/api/breaks` (docs/PLAN-breaks.md B2): the member's screen-break settings.

import type { BreakSettings } from '@hotsauce/format'
import { request } from './client'

export interface BreaksView {
  settings: BreakSettings
  /** False until the member saves: they see the defaults. */
  saved: boolean
}

export const breaksApi = {
  get: () => request<BreaksView>('/api/breaks'),
  save: (settings: BreakSettings) =>
    request<BreaksView>('/api/breaks', { method: 'PUT', json: { settings } }),
}
