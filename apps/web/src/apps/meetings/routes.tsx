import type { RouteObject } from 'react-router'

// Under /meetings (ARCHITECTURE §7.5). Each page is its own chunk; the note page shares the
// editor chunk with Docs.
export const meetingsRoutes: RouteObject[] = [
  {
    index: true,
    lazy: async () => ({ Component: (await import('./MeetingsHome')).default }),
  },
  {
    path: 'start',
    lazy: async () => ({ Component: (await import('./StartMeeting')).default }),
  },
  {
    path: 'live/:id',
    lazy: async () => ({ Component: (await import('./LiveMeeting')).default }),
  },
  {
    path: 'extension',
    lazy: async () => ({ Component: (await import('./ChromeExtension')).default }),
  },
  {
    path: 'ask',
    lazy: async () => ({ Component: (await import('./AskMeetings')).default }),
  },
  {
    path: 'brief',
    lazy: async () => ({ Component: (await import('./AgentBrief')).default }),
  },
  {
    path: 'import',
    lazy: async () => ({ Component: (await import('./ImportGranola')).default }),
  },
  {
    path: 'booking',
    lazy: async () => ({ Component: (await import('./booking/BookingLinks')).default }),
  },
  {
    path: ':space/*',
    lazy: async () => ({ Component: (await import('./MeetingNote')).default }),
  },
]
