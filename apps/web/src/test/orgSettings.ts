// Serves a signed-in member or admin and the organization editor, for Settings tests.

import { HttpResponse, http } from 'msw'
import type { OrgState } from '../api/org'
import { server, TEST_USER } from './mockServer'

const secret = { set: false, last4: null, source: null }

export function orgState(): OrgState {
  return {
    settings: {
      orgName: 'Acme Labs',
      productName: '',
      allowedDomains: ['acme.test'],
      allowedEmails: [],
      adminEmails: [TEST_USER],
      clerkPublishableKey: '',
      hostKind: 'local',
      githubOrg: '',
      forgejoUrl: '',
      forgejoOrg: '',
      s3Endpoint: '',
      s3Region: '',
      r2AccountId: '',
      r2AccessKeyId: '',
      r2Bucket: '',
      keepAudio: false,
      chatUrl: 'https://chat.acme.test',
      stepsDone: [],
      setupComplete: true,
    },
    secrets: {
      CLERK_SECRET_KEY: secret,
      ANTHROPIC_API_KEY: secret,
      DEEPGRAM_API_KEY: secret,
      GITHUB_TOKEN: secret,
      FORGEJO_TOKEN: secret,
      R2_SECRET_ACCESS_KEY: secret,
    } as OrgState['secrets'],
    lockedByEnv: {},
    effective: {
      orgName: 'Acme Labs',
      productName: 'Hotsauce',
      allowedDomains: ['acme.test'],
      allowedEmails: [],
      adminEmails: [TEST_USER],
      hostKind: 'local',
      ai: false,
      transcription: false,
      publicUrl: '',
    },
    brand: {
      primary: '#c63d19',
      accent: '#e8a13a',
      neutral: 'warm',
      fonts: 'classic',
      defaultTheme: 'system',
      logo: null,
      mark: null,
      voice: '',
    },
    fontChoices: {
      classic: { label: 'Classic', display: 'serif', ui: 'sans-serif' },
    } as OrgState['fontChoices'],
    setupMode: false,
    missing: [],
  }
}

/** Signs the test user in as an admin (or not) and serves the organization editor. */
export function serveOrg({ admin }: { admin: boolean }) {
  let state = orgState()
  const saves: Record<string, unknown>[] = []
  server.use(
    http.get('/api/me', () =>
      HttpResponse.json({
        principal: {
          userId: 'user_test',
          email: TEST_USER,
          name: 'Test User',
          handle: 'test',
          isAdmin: admin,
        },
        spaces: [{ name: 'team', kind: 'team', label: 'Team' }],
        settings: { idleCommitMs: 60000 },
      }),
    ),
    http.get('/api/admin/org/state', () =>
      admin ? HttpResponse.json(state) : new HttpResponse(null, { status: 403 }),
    ),
    http.put('/api/admin/org/settings', async ({ request }) => {
      const patch = (await request.json()) as Record<string, unknown>
      saves.push(patch)
      const { allowedDomains, allowedEmails, adminEmails, ...rest } = patch
      const list = (v: unknown, old: string[]) =>
        typeof v === 'string'
          ? v
              .split(',')
              .map((x) => x.trim())
              .filter(Boolean)
          : old
      state = {
        ...state,
        settings: {
          ...state.settings,
          ...(rest as Partial<OrgState['settings']>),
          allowedDomains: list(allowedDomains, state.settings.allowedDomains),
          allowedEmails: list(allowedEmails, state.settings.allowedEmails),
          adminEmails: list(adminEmails, state.settings.adminEmails),
        },
      }
      return HttpResponse.json(state)
    }),
    // The sections that load their own data: nothing set up on this server.
    http.get('/api/admin/org/updates', () => new HttpResponse(null, { status: 404 })),
    http.get('/api/admin/org/backups', () => new HttpResponse(null, { status: 404 })),
    http.get('/api/sharing', () => HttpResponse.json({ publicShareLinks: false })),
    http.get('/api/share-links', () => HttpResponse.json({ links: [] })),
    http.get('/api/forms/rooms', () => HttpResponse.json({ rooms: [] })),
  )
  return saves
}
