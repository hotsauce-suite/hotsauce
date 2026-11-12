import { product } from '../../brand/product'
import { driveFileUrl } from '../../lib/paths'
import type { AppManifest } from '../registry'

/** Files: team files and attachments; bytes in object storage, a pointer per file (§18). */
export const filesApp: AppManifest = {
  id: 'files',
  get name() {
    return `${product()} Files`
  },
  label: 'Files',
  icon: 'drive',
  codename: 'Files',
  route: '/files',
  folder: 'files',
  urlFor: driveFileUrl,
  preload: () => import('./FilesPage'),
}
