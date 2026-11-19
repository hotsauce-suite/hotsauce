// Client for the first-run tour's seen flag (docs/PLAN-tour-and-101.md S1, S2).

import { request } from './client'

export const tourApi = {
  get: () => request<{ seen: boolean }>('/api/tour'),
  markSeen: () => request<{ seen: true }>('/api/tour/seen', { method: 'POST' }),
}
