import { product } from '../../brand/product'
import { boardUrl } from '../../lib/paths'
import type { AppManifest } from '../registry'

/** Whiteboard: Excalidraw boards, one per file, `boards/<id>.md` (ARCHITECTURE §15). */
export const boardsApp: AppManifest = {
  id: 'boards',
  get name() {
    return `${product()} Whiteboard`
  },
  label: 'Boards',
  icon: 'board',
  codename: 'Whiteboard',
  route: '/boards',
  folder: 'boards',
  urlFor: boardUrl,
  preload: () => import('./BoardsPage'),
}
