import { product } from '../../brand/product'
import { tableFileUrl } from '../../lib/paths'
import type { AppManifest } from '../registry'

/** Tables: trackers with spreadsheet formulas, kept as CSV in Git (ARCHITECTURE §22). */
export const tablesApp: AppManifest = {
  id: 'tables',
  get name() {
    return `${product()} Tables`
  },
  label: 'Tables',
  icon: 'table',
  codename: 'Tables',
  route: '/tables',
  folder: 'tables',
  urlFor: (space, path) => tableFileUrl(space, path) ?? '/tables',
  // The grid needs the whole width.
  sidebar: false,
  preload: () => import('./TablesPage'),
}
