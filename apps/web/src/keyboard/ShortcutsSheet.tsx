import { Link } from 'react-router'
import type { AppId } from '../apps/registry'
import { Dialog } from '../components/Dialog'
import { SECTIONS, type SectionId, SHORTCUTS, shortcutIds } from './catalog'
import { Keys } from './KeyCaps'
import { useSingleKeys } from './prefs'
import { useBoundIds } from './shortcuts'

/**
 * The `?` sheet: every shortcut, Everywhere and Go to first, then what works on this page (sections with
 * a bound shortcut, or the open app's own), then the rest.
 */
export function ShortcutsSheet({ app, onClose }: { app: AppId | null; onClose: () => void }) {
  const bound = new Set(useBoundIds())
  const singleKeys = useSingleKeys()
  const sections = Object.keys(SECTIONS) as SectionId[]
  const here = (s: SectionId) =>
    (app !== null && SECTIONS[s].app === app) ||
    shortcutIds.some((id) => SHORTCUTS[id].section === s && bound.has(id))
  const always = sections.filter((s) => SECTIONS[s].always)
  const rest = sections.filter((s) => !SECTIONS[s].always)
  const ordered = [...always, ...rest.filter(here), ...rest.filter((s) => !here(s))]

  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} testId="shortcuts-sheet" wide>
      {singleKeys ? null : (
        <p className="mb-4 rounded-lg bg-paper-sunk px-3 py-2 text-sm text-ink-soft">
          Single-key shortcuts are off. Only shortcuts with ⌘ or Ctrl work.{' '}
          <Link to="/settings#keyboard" onClick={onClose} className="text-ember-strong underline">
            Change in Settings
          </Link>
        </p>
      )}
      <div className="columns-1 gap-8 sm:columns-2 lg:columns-3">
        {ordered.map((s) => {
          const ids = shortcutIds.filter((id) => SHORTCUTS[id].section === s)
          if (!ids.length) return null
          return (
            <section
              key={s}
              aria-label={SECTIONS[s].title}
              data-testid={`shortcuts-${s}`}
              className="mb-6 break-inside-avoid"
            >
              <h3 className="mb-2 flex items-baseline gap-2 text-sm font-semibold text-ink">
                {SECTIONS[s].title}
                {!SECTIONS[s].always && here(s) ? (
                  <span className="text-xs font-normal text-ember-strong">On this page</span>
                ) : null}
              </h3>
              <ul className="flex flex-col gap-1.5">
                {ids.map((id) => (
                  <li key={id} className="flex items-start justify-between gap-3 text-sm">
                    <span className="min-w-0 text-ink-soft">{SHORTCUTS[id].label}</span>
                    <span className="flex shrink-0 flex-wrap justify-end gap-1.5">
                      {SHORTCUTS[id].keys.map((spec) => (
                        <Keys key={spec} spec={spec} />
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
    </Dialog>
  )
}
