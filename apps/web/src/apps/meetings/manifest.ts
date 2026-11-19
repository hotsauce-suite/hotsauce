import { product } from '../../brand/product'
import { meetingUrl } from '../../lib/paths'
import type { AppManifest } from '../registry'

export const meetingsApp: AppManifest = {
  id: 'meetings',
  get name() {
    return `${product()} Meetings`
  },
  label: 'Meetings',
  about: 'Record meetings and get notes and a transcript.',
  icon: 'calendar',
  codename: 'Log',
  route: '/meetings',
  folder: 'meetings',
  urlFor: meetingUrl,
  preload: () => import('./MeetingsHome'),
}
