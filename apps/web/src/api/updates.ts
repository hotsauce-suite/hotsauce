import { request } from './client'

/** Settings → Organization → Updates (docs/PLAN-releases-and-updates.md). Admins only. */
export interface UpdateStatus {
  current: string
  latest: { version: string; notes: string; url: string; publishedAt: string } | null
  updateAvailable: boolean
  checkedAt: string | null
  /** fly: Update works here; fly-needs-token: on Fly without FLY_API_TOKEN; manual: elsewhere. */
  mode: 'fly' | 'fly-needs-token' | 'manual'
  auto: boolean
  updating: { from: string; to: string; at: string } | null
  failed: { from: string; to: string; at: string } | null
  flyApp: string | null
}

export const updatesApi = {
  status: () => request<UpdateStatus>('/api/admin/org/updates'),
  check: () => request<UpdateStatus>('/api/admin/org/updates/check', { method: 'POST' }),
  setAuto: (on: boolean) =>
    request<UpdateStatus>('/api/admin/org/updates/auto', { method: 'PUT', json: { on } }),
  start: () => request<UpdateStatus>('/api/admin/org/updates/start', { method: 'POST' }),
}
