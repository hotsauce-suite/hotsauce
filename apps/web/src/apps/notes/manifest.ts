import { product } from '../../brand/product'
import { noteUrl } from '../../lib/paths'
import type { AppManifest } from '../registry'

/** Notes: a Keep-style board; one note per file, `notes/<id>.md` (§14). */
export const notesApp: AppManifest = {
  id: 'notes',
  get name() {
    return `${product()} Notes`
  },
  label: 'Notes',
  icon: 'notes',
  codename: 'Notes',
  route: '/notes',
  folder: 'notes',
  urlFor: noteUrl,
  preload: () => import('./NotesPage'),
}
