import { product } from '../../brand/product'
import { linkFileUrl } from '../../lib/paths'
import type { AppManifest } from '../registry'

/** Saved links: a read-later list, one file per link, `links/<id>.md` (ARCHITECTURE §23). */
export const linksApp: AppManifest = {
  id: 'links',
  get name() {
    return `${product()} Links`
  },
  label: 'Links',
  icon: 'bookmark',
  codename: 'Links',
  route: '/links',
  folder: 'links',
  urlFor: (space, path) => linkFileUrl(space, path) ?? '/links',
  sidebar: false,
  preload: () => import('./LinksPage'),
}
