import type { RouteObject } from 'react-router'

/** `/settings` and its pages (docs/PLAN-settings-pages.md); the app's router and the tests share it. */
export const settingsRoute: RouteObject = {
  path: '/settings',
  lazy: async () => ({ Component: (await import('./SettingsLayout')).default }),
  children: [
    {
      index: true,
      lazy: async () => ({ Component: (await import('../SettingsRoute')).GeneralSettings }),
    },
    {
      path: 'connections',
      lazy: async () => ({ Component: (await import('../SettingsRoute')).ConnectionsSettings }),
    },
    {
      path: 'apps',
      lazy: async () => ({ Component: (await import('../SettingsRoute')).AppsSettings }),
    },
    {
      path: 'organization/:page?',
      lazy: async () => ({ Component: (await import('../OrgSettingsRoute')).default }),
    },
  ],
}
