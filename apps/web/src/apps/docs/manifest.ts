import { product } from '../../brand/product'
import { docUrl } from '../../lib/paths'
import type { AppManifest } from '../registry'

export const docsApp: AppManifest = {
  id: 'docs',
  get name() {
    return `${product()} Docs`
  },
  label: 'Docs',
  about: 'Write and share documents with your team.',
  icon: 'docs',
  codename: 'Mantle',
  route: '/docs',
  folder: 'docs',
  urlFor: docUrl,
  preload: () => import('../../routes/DocsIndex'),
}
