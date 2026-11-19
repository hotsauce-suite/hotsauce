// The hot sauce Easter eggs' pure rules (docs/PLAN-easter-eggs.md): no DOM, so they are easy to test.

/** ↑ ↑ ↓ ↓ ← → ← → B A, as `KeyboardEvent.key` values (letters in lower case). */
export const KONAMI = [
  'ArrowUp',
  'ArrowUp',
  'ArrowDown',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'ArrowLeft',
  'ArrowRight',
  'b',
  'a',
] as const

/**
 * Follows key presses and says true on the one that completes the Konami code (E1). A wrong key
 * starts over, counting itself if it begins the code again.
 */
export function konamiTracker(): (key: string) => boolean {
  let at = 0
  return (raw: string) => {
    const key = raw.length === 1 ? raw.toLowerCase() : raw
    if (key === KONAMI[at]) at += 1
    // ↑ ↑ ↑ still leaves the last two ups as a good start; any other wrong key starts over.
    else if (key === 'ArrowUp') at = at === 2 ? 2 : 1
    else at = 0
    if (at < KONAMI.length) return false
    at = 0
    return true
  }
}

/** A task worth a pepper burst when it's done (E5): it has 🌶 or says "hot sauce" (two words, so "Hotsauce" itself doesn't count). */
export function isSpicy(title: string): boolean {
  return /\u{1F336}|\bhot[\s-]+sauce\b/iu.test(title)
}

/** National Hot Sauce Day, January 22, by the device's own calendar (E7). */
export function isHotSauceDay(now: Date): boolean {
  return now.getMonth() === 0 && now.getDate() === 22
}

export const HOT_SAUCE_DAY_LINE = 'Happy National Hot Sauce Day 🌶'

/** The note for whoever opens the browser's console (E8): a big pepper, then a line under it. */
export const CONSOLE_NOTE = {
  text: '%c🌶%c Hotsauce is open source, come add some heat: https://github.com/hotsauce-suite/hotsauce',
  styles: ['font-size: 32px', 'font-size: 13px; color: #c63d19; font-weight: 600'],
} as const
