import { personUrl } from '../../api/people'
import { product } from '../../brand/product'
import type { AppManifest } from '../registry'

/**
 * People: everyone you've met, from meeting attendees, the calendar and task assignees
 * (ARCHITECTURE §17). Its only files are the team's About notes, `people/<email>.md`.
 */
export const peopleApp: AppManifest = {
  id: 'people',
  get name() {
    return `${product()} People`
  },
  label: 'People',
  icon: 'people',
  codename: 'People',
  route: '/people',
  folder: 'people',
  urlFor: (_space, path) => personUrl(path.replace(/^people\//, '').replace(/\.md$/i, '')),
  sidebar: false,
  // The phone bar is full; people open from a meeting's attendees or a link.
  onPhoneBar: false,
  preload: () => import('./PeoplePages'),
}
