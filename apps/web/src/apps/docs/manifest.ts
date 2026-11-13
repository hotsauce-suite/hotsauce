import { product } from '../../brand/product'
import { docUrl } from '../../lib/paths'
import type { AppManifest } from '../registry'

export const docsApp: AppManifest = {
  id: 'docs',
  get name() {
    return `${product()} Docs`
  },
  label: 'Docs',
  icon: 'docs',
  codename: 'Mantle',
  route: '/docs',
  folder: 'docs',
  urlFor: docUrl,
  onPhoneBar: true,
  preload: () => import('../../routes/DocsIndex'),
}
