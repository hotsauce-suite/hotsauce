// Turns on the hot sauce Easter eggs for the signed-in app (docs/PLAN-easter-eggs.md): the Konami
// code (E1), the ⌘K phrases (E3), the console note (E8) and the Mac app's hidden menu item (E9).

import { useEffect } from 'react'
import { useCommands } from '../keyboard/commands'
import { lessHeat, moreHeat } from './ghostPepper'
import { CONSOLE_NOTE, konamiTracker } from './logic'
import { pepperShower } from './peppers'

/** What the Mac app sends when its "Add more heat 🌶" menu item is picked (E9). */
export const MORE_HEAT_EVENT = 'hotsauce:more-heat'

/** Typing in a field, an editor or a select doesn't count toward the Konami code. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

let noted = false
/** Once per page load, for whoever opens the console. */
export function noteInConsole(): void {
  if (noted) return
  noted = true
  try {
    console.info(CONSOLE_NOTE.text, ...CONSOLE_NOTE.styles)
  } catch {}
}

export function useEggs(): void {
  useEffect(() => {
    noteInConsole()
    const konami = konamiTracker()
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return
      if (konami(e.key)) pepperShower()
    }
    const onMac = () => pepperShower()
    document.addEventListener('keydown', onKey)
    window.addEventListener(MORE_HEAT_EVENT, onMac)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener(MORE_HEAT_EVENT, onMac)
    }
  }, [])

  useCommands([
    {
      id: 'egg-more-heat',
      title: 'More heat 🌶',
      group: 'prefs',
      secret: ['more heat', 'ghost pepper'],
      run: () => moreHeat(),
    },
    {
      id: 'egg-less-heat',
      title: 'Less heat',
      group: 'prefs',
      secret: ['less heat'],
      run: () => lessHeat(),
    },
  ])
}
