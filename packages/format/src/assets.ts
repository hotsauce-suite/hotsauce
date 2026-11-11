import { slugify } from './paths.js'
import { SPACE_LAYOUT } from './space.js'

/**
 * `assets/YYYY/MM/<slug>-<id8>.<ext>`, dated in the runtime's local time zone. `id8` is the last
 * eight characters of `id`: a ULID's leading characters are its timestamp, so two pastes of
 * `image.png` in the same second would share them.
 */
export function assetPath(originalName: string, now: Date, id: string): string {
  const name = originalName.split(/[/\\]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext =
    dot > 0
      ? name
          .slice(dot + 1)
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '')
      : ''
  const yyyy = String(now.getFullYear()).padStart(4, '0')
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const file = `${slugify(stem)}-${id.slice(-8)}${ext ? `.${ext}` : ''}`
  return `${SPACE_LAYOUT.assets}/${yyyy}/${mm}/${file}`
}
