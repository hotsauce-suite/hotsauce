// The pages of Settings (docs/PLAN-settings-pages.md, L1): three for everyone, five more for admins.

export interface SettingsPage {
  id: string
  label: string
  to: string
}

export const YOUR_PAGES: SettingsPage[] = [
  { id: 'general', label: 'General', to: '/settings' },
  { id: 'connections', label: 'Connections', to: '/settings/connections' },
  { id: 'apps', label: 'Apps', to: '/settings/apps' },
]

export type OrgPageId = 'workspace' | 'brand' | 'people' | 'ai' | 'data'

export const ORG_PAGES: (SettingsPage & { id: OrgPageId })[] = [
  { id: 'workspace', label: 'Workspace', to: '/settings/organization' },
  { id: 'brand', label: 'Brand', to: '/settings/organization/brand' },
  { id: 'people', label: 'People and access', to: '/settings/organization/people' },
  { id: 'ai', label: 'AI', to: '/settings/organization/ai' },
  { id: 'data', label: 'Data and updates', to: '/settings/organization/data' },
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
