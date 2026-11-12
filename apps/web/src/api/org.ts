import { request } from './client'

/** Settings → Organization and the setup wizard (ARCHITECTURE §11). */

export const SECRET_NAMES = [
  'CLERK_SECRET_KEY',
  'ANTHROPIC_API_KEY',
  'DEEPGRAM_API_KEY',
  'GITHUB_TOKEN',
  'R2_SECRET_ACCESS_KEY',
  'WEBHOOK_SECRET',
] as const
export type SecretName = (typeof SECRET_NAMES)[number]

export interface OrgSettings {
  orgName: string
  productName: string
  allowedDomains: string[]
  allowedEmails: string[]
  adminEmails: string[]
  clerkPublishableKey: string
  hostKind: 'local' | 'github'
  githubOrg: string
  r2AccountId: string
  r2AccessKeyId: string
  r2Bucket: string
  keepAudio: boolean
  chatUrl: string
  stepsDone: string[]
  setupComplete: boolean
  completedAt?: string
}

export interface SecretStatus {
  set: boolean
  last4: string | null
  source: 'env' | 'saved' | null
}

export type FontChoice = 'classic' | 'modern' | 'editorial' | 'friendly' | 'technical' | 'simple'

export interface Brand {
  primary: string
  accent: string
  neutral: 'warm' | 'cool' | 'gray'
  fonts: FontChoice
  defaultTheme: 'system' | 'light' | 'dark'
  logo: string | null
  mark: string | null
  voice: string
  updatedAt?: string
}

export interface OrgState {
  settings: OrgSettings
  secrets: Record<SecretName, SecretStatus>
  /** 'cloudflare' when the server's disk is temporary: repositories in GitHub, video in R2. */
  platform?: 'server' | 'cloudflare'
  lockedByEnv: Partial<Record<keyof OrgSettings, boolean>>
  effective: {
    orgName: string
    productName: string
    allowedDomains: string[]
    allowedEmails: string[]
    adminEmails: string[]
    hostKind: string
    ai: boolean
    transcription: boolean
    publicUrl: string
  }
  brand: Brand
  fontChoices: Record<FontChoice, { label: string; display: string; ui: string }>
  setupMode: boolean
  /** What finishing still needs; empty when ready. */
  missing: string[]
}

export type SettingsPatch = Partial<
  Omit<
    OrgSettings,
    'allowedDomains' | 'allowedEmails' | 'adminEmails' | 'setupComplete' | 'completedAt'
  >
> & {
  allowedDomains?: string | string[]
  allowedEmails?: string | string[]
  adminEmails?: string | string[]
  secrets?: Partial<Record<SecretName, string>> | undefined
  addStepDone?: string
}

export interface KeyTest {
  ok: boolean
  message: string
}

export type TestProvider = 'anthropic' | 'deepgram' | 'clerk' | 'github'

/** One editor, two doors: the setup wizard (with its token) or an admin's session. */
export function orgEditor(setupToken: string | null) {
  const base = setupToken ? '/api/setup' : '/api/admin/org'
  const headers: Record<string, string> = setupToken ? { 'x-setup-token': setupToken } : {}
  return {
    state: () => request<OrgState>(`${base}/state`, { headers }),
    saveSettings: (patch: SettingsPatch) =>
      request<OrgState>(`${base}/settings`, { method: 'PUT', json: patch, headers }),
    saveBrand: (patch: Partial<Brand>) =>
      request<OrgState>(`${base}/brand`, { method: 'PUT', json: patch, headers }),
    uploadAsset: (kind: 'logo' | 'mark', file: File) =>
      request<OrgState>(`${base}/assets/${kind}`, {
        method: 'PUT',
        body: file,
        contentType: file.type,
        headers,
      }),
    removeAsset: (kind: 'logo' | 'mark') =>
      request<OrgState>(`${base}/assets/${kind}`, { method: 'DELETE', headers }),
    test: (provider: TestProvider, key?: string, extra?: string) =>
      request<KeyTest>(`${base}/test/${provider}`, {
        method: 'POST',
        json: { ...(key ? { key } : {}), ...(extra !== undefined ? { extra } : {}) },
        headers,
      }),
    finish: () =>
      request<{ ok: true; restarting: boolean }>(`${base}/finish`, { method: 'POST', headers }),
    apply: () =>
      request<{ ok: true; restarting: boolean }>(`${base}/apply`, { method: 'POST', headers }),
  }
}
export type OrgEditor = ReturnType<typeof orgEditor>

/** Waits for the server to come back after it restarts to apply new settings. */
export async function waitForRestart(timeoutMs = 60_000): Promise<boolean> {
  const started = Date.now()
  // Give it a moment to go down first, so we don't see the old process answer.
  await new Promise((r) => setTimeout(r, 1500))
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' })
      if (res.ok) {
        const body = (await res.json()) as { setupRequired?: boolean }
        if (!body.setupRequired) return true
      }
    } catch {
      // Still restarting.
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}
