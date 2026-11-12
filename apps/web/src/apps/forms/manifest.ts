import { product } from '../../brand/product'
import { formFileUrl } from '../../lib/paths'
import type { AppManifest } from '../registry'

/** Forms: surveys and requests whose answers land in Git (ARCHITECTURE §21). */
export const formsApp: AppManifest = {
  id: 'forms',
  get name() {
    return `${product()} Forms`
  },
  label: 'Forms',
  icon: 'form',
  codename: 'Forms',
  route: '/forms',
  folder: 'forms',
  urlFor: (space, path) => formFileUrl(space, path) ?? '/forms',
  // One page wide: the list, the builder and the answers need the room.
  sidebar: false,
  // The phone bar is full; on a phone Forms opens from links.
  onPhoneBar: false,
  preload: () => import('./FormsPage'),
}
