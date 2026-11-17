import { product } from '../../brand/product'
import { taskUrl } from '../../lib/paths'
import type { AppManifest } from '../registry'

/** Tasks: one task per file, `tasks/<id>.md`, in the team or a personal space (§12). */
export const tasksApp: AppManifest = {
  id: 'tasks',
  get name() {
    return `${product()} Tasks`
  },
  label: 'Tasks',
  icon: 'tasks',
  codename: 'Tasks',
  route: '/tasks',
  folder: 'tasks',
  urlFor: taskUrl,
  preload: () => import('./TasksPage'),
}
