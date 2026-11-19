import type { AppManifest } from '../registry'

/** For you: one list of what is waiting on the member, worked out from comments (ARCHITECTURE §27.5). */
export const forYouApp: AppManifest = {
  id: 'for-you',
  name: 'For you',
  label: 'For you',
  about: 'Mentions, replies and tasks waiting for you.',
  icon: 'at',
  codename: 'For you',
  route: '/for-you',
  folder: '',
  urlFor: () => '/for-you',
  sidebar: false,
  preload: () => import('./ForYouPage'),
}
