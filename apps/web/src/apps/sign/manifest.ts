import { product } from '../../brand/product'
import { signFileUrl } from '../../lib/paths'
import type { AppManifest } from '../registry'

/** Sign: send a PDF from Files for signature; the sealed copy goes back into Files (docs/PLAN-sign.md). */
export const signApp: AppManifest = {
  id: 'sign',
  get name() {
    return `${product()} Sign`
  },
  label: 'Sign',
  icon: 'sign',
  codename: 'Sign',
  route: '/sign',
  folder: 'sign',
  urlFor: (space, path) => signFileUrl(space, path) ?? '/sign',
  // One page wide: the PDF's pages need the room.
  sidebar: false,
  preload: () => import('./SignPage'),
}
