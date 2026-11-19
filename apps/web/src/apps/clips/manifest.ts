import { product } from '../../brand/product'
import { docUrl } from '../../lib/paths'
import type { AppManifest } from '../registry'

/** Hotsauce Clips keeps no files in a space: clips live in their own store (ARCHITECTURE §10). */
export const clipsApp: AppManifest = {
  id: 'clips',
  get name() {
    return `${product()} Clips`
  },
  label: 'Clips',
  about: 'Record your screen and share it with a link.',
  icon: 'video',
  codename: 'Clips',
  route: '/clips',
  folder: '',
  urlFor: docUrl,
  preload: () => import('./ClipsLibrary'),
}
