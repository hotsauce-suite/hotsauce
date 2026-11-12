import { product } from '../../brand/product'
import { docUrl } from '../../lib/paths'
import type { AppManifest } from '../registry'

/** Hearth Clips keeps no files in a space: clips live in their own store (ARCHITECTURE §10). */
export const clipsApp: AppManifest = {
  id: 'clips',
  get name() {
    return `${product()} Clips`
  },
  label: 'Clips',
  icon: 'video',
  codename: 'Clips',
  route: '/clips',
  folder: '',
  urlFor: docUrl,
  // Phone browsers can't record the screen; Clips still opens from a link.
  onPhoneBar: false,
  preload: () => import('./ClipsLibrary'),
}
