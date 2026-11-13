import { product } from '../../brand/product'
import { docUrl } from '../../lib/paths'
import type { AppManifest } from '../registry'

/** Briefcast: a spoken briefing each weekday morning (docs/plans/2026-11-12-briefcast.md). */
export const briefcastApp: AppManifest = {
  id: 'briefcast',
  get name() {
    return `${product()} Briefcast`
  },
  label: 'Briefcast',
  icon: 'headphones',
  codename: 'Briefcast',
  route: '/briefcast',
  folder: '',
  urlFor: docUrl,
  preload: () => import('./BriefcastPage'),
}
