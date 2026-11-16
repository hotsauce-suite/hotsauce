import { request } from './client'

/** Settings → Organization → Usage (docs/PLAN-app-usage.md). Admins only; numbers only. */
export interface UsageWeek {
  /** The week's Monday, YYYY-MM-DD (UTC). */
  week: string
  created: number
  changed: number
  people: number
}

export interface AppUsage {
  /** An app id from the registry, or `pages` (pages AI tools publish). */
  id: string
  weeks: UsageWeek[]
  total: { created: number; changed: number; people: number }
  peopleLast4Weeks: number
}

export interface UsageReport {
  generatedAt: string
  weeks: string[]
  /** Busiest first. */
  apps: AppUsage[]
  dictate: { connectedMacs: number; usedLast7Days: number }
}

export const usageApi = {
  get: () => request<UsageReport>('/api/admin/usage'),
}
