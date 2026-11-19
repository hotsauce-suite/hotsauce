import { product } from '../../brand/product'
import { docUrl } from '../../lib/paths'
import type { AppManifest } from '../registry'

/** Hotsauce Dictate keeps no files: its page is setup for the Mac app. */
export const dictateApp: AppManifest = {
  id: 'dictate',
  get name() {
    return `${product()} Dictate`
  },
  label: 'Dictate',
  about: 'Talk instead of typing, in any app on your Mac.',
  icon: 'mic',
  codename: 'Bellows',
  route: '/dictate',
  folder: '',
  urlFor: docUrl,
  preload: () => import('./DictatePage'),
}
