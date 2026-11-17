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
      // The Mac app's own settings, only inside it (docs/PLAN-one-settings.md).
      path: 'mac',
      lazy: async () => ({ Component: (await import('./ThisMacPage')).default }),
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
      // Release notes, from the version under the menu (docs/PLAN-mac-version-and-whats-new.md N5).
      path: 'whats-new',
      lazy: async () => ({ Component: (await import('./WhatsNewPage')).default }),
    },
    {
      path: 'organization/:page?',
      lazy: async () => ({ Component: (await import('../OrgSettingsRoute')).default }),
    },
  ],
}
