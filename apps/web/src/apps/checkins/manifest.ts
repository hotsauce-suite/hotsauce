import { product } from '../../brand/product'
import type { AppManifest } from '../registry'

/** `checkins/<id>.md` → `/checkins/<id>`; an answer or summary → its check-in and round. */
export function checkinFileUrl(path: string): string {
  const [, id, date] = path.split('/')
  const clean = (id ?? '').replace(/\.md$/, '')
  if (!clean) return '/checkins'
  return date ? `/checkins/${clean}?date=${date}` : `/checkins/${clean}`
}

/** Check-ins: a question asked on a schedule, answered by the team (ARCHITECTURE §24). */
export const checkinsApp: AppManifest = {
  id: 'checkins',
  get name() {
    return `${product()} Check-ins`
  },
  label: 'Check-ins',
  icon: 'checklist',
  codename: 'Check-ins',
  route: '/checkins',
  folder: 'checkins',
  urlFor: (_space, path) => checkinFileUrl(path),
  sidebar: false,
  preload: () => import('./CheckinsPage'),
}
