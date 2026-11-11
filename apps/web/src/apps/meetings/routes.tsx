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
    path: ':space/*',
    lazy: async () => ({ Component: (await import('./MeetingNote')).default }),
  },
]
