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
  about: 'Keep and share PDFs, decks and spreadsheets.',
  icon: 'drive',
  codename: 'Files',
  route: '/files',
  folder: 'files',
  urlFor: driveFileUrl,
  preload: () => import('./FilesPage'),
}
