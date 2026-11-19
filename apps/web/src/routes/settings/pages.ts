// The pages of Settings (docs/PLAN-settings-pages.md, L1): four for everyone, six more for admins
// (Usage: docs/PLAN-app-usage.md).

export interface SettingsPage {
  id: string
  label: string
  to: string
}

export const YOUR_PAGES: SettingsPage[] = [
  { id: 'general', label: 'General', to: '/settings' },
  { id: 'appearance', label: 'Appearance', to: '/settings/appearance' },
  { id: 'connections', label: 'Connections', to: '/settings/connections' },
  { id: 'apps', label: 'Apps', to: '/settings/apps' },
  { id: 'guide', label: 'Hotsauce 101', to: '/settings/101' },
]

/** Only inside the Mac app, first in the menu (docs/PLAN-one-settings.md R1). */
export const MAC_PAGE: SettingsPage = { id: 'mac', label: 'This Mac', to: '/settings/mac' }

export type OrgPageId = 'workspace' | 'brand' | 'people' | 'ai' | 'data' | 'usage'

export const ORG_PAGES: (SettingsPage & { id: OrgPageId })[] = [
  { id: 'workspace', label: 'Workspace', to: '/settings/organization' },
  { id: 'brand', label: 'Brand', to: '/settings/organization/brand' },
  { id: 'people', label: 'People and access', to: '/settings/organization/people' },
  { id: 'ai', label: 'AI', to: '/settings/organization/ai' },
  { id: 'data', label: 'Data and updates', to: '/settings/organization/data' },
  { id: 'usage', label: 'Usage', to: '/settings/organization/usage' },
]

/** The organization page a `/settings/organization/:page?` address names; null for an unknown one. */
export function orgPageOf(param: string | undefined): OrgPageId | null {
  if (!param) return 'workspace'
  return ORG_PAGES.find((p) => p.id === param)?.id ?? null
}

/**
 * Where a section lives now, for addresses from before Settings had pages (`/settings#mac-app`,
 * G4). Sections on General (`#notifications`, `#keyboard`) aren't listed: they stay put.
 */
const MOVED: Record<string, string> = {
  appearance: '/settings/appearance',
  'mac-app': '/settings/apps',
  calendars: '/settings/connections',
  'ai-tools': '/settings/connections',
}

/** The page an old `/settings#section` address should open instead, or null to stay. */
export function movedSection(pathname: string, hash: string): string | null {
  if (pathname !== '/settings' && pathname !== '/settings/') return null
  const to = MOVED[hash.replace(/^#/, '')]
  return to ? `${to}${hash}` : null
}
