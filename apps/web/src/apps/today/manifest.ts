import { product } from '../../brand/product'
import type { AppManifest } from '../registry'

/** Today: the home page, the member's day on one screen (ARCHITECTURE §16). It keeps no files. */
export const todayApp: AppManifest = {
  id: 'today',
  get name() {
    return `${product()} Today`
  },
  label: 'Today',
  icon: 'today',
  codename: 'Today',
  route: '/today',
  folder: '',
  urlFor: () => '/today',
  // One page, nothing to list beside it.
  sidebar: false,
  onPhoneBar: true,
  preload: () => import('./TodayPage'),
}
