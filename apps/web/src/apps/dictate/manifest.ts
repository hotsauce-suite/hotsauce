import { product } from '../../brand/product'
import { docUrl } from '../../lib/paths'
import type { AppManifest } from '../registry'

/** Hearth Dictate keeps no files: its page is setup for the Mac app. */
export const dictateApp: AppManifest = {
  id: 'dictate',
  get name() {
    return `${product()} Dictate`
  },
  label: 'Dictate',
  icon: 'mic',
  codename: 'Bellows',
  route: '/dictate',
  folder: '',
  urlFor: docUrl,
  preload: () => import('./DictatePage'),
}
