/**
 * Recording the screenshot shortcut on Settings → This Mac (docs/PLAN-screenshots.md R15). The
 * page turns a key press into the chord's text ("⌥⇧4"), the way the Mac app writes it
 * (apps/dictate-mac ScreenshotShortcut), and says straight away why one can't be used. The Mac
 * checks again and keeps its old shortcut if it disagrees.
 */

export interface KeyPress {
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

const NAMED: Record<string, string> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Quote: "'",
  Semicolon: ';',
  Backslash: '\\',
  Comma: ',',
  Slash: '/',
  Period: '.',
  Backquote: '`',
  Enter: '↩',
  Tab: '⇥',
  Space: 'Space',
  Backspace: '⌫',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowDown: '↓',
  ArrowUp: '↑',
}

/** The key's name as the Mac shows it, or null for a modifier on its own or a key it can't use. */
export function keyName(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1] ?? null
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit) return digit[1] ?? null
  const fn = /^F([1-9]|1[0-2])$/.exec(code)
  if (fn) return code
  return NAMED[code] ?? null
}

/** "⌥⇧4" for Option-Shift-4; null while only modifiers are down. Modifiers in Apple's order. */
export function chordFromKey(press: KeyPress): string | null {
  const key = keyName(press.code)
  if (!key) return null
  return (
    (press.ctrlKey ? '⌃' : '') +
    (press.altKey ? '⌥' : '') +
    (press.shiftKey ? '⇧' : '') +
    (press.metaKey ? '⌘' : '') +
    key
  )
}

/** Why a chord can't be the screenshot shortcut, or null when it can (as the Mac decides). */
export function chordRefusal(chord: string): string | null {
  const mods = /^[⌃⌥⇧⌘]*/.exec(chord)?.[0] ?? ''
  const key = chord.slice(mods.length)
  if (!key) return 'Press a key with the modifiers.'
  if (!/[⌘⌥⌃]/.test(mods)) return 'Add ⌘, ⌥ or ⌃, so the shortcut doesn’t get in the way of typing.'
  if (mods === '⌘') return '⌘ on its own would take over app shortcuts like ⌘C. Add ⌥, ⌃ or ⇧.'
  if (mods === '⇧⌘' && ['3', '4', '5', '6'].includes(key))
    return `macOS uses ${chord} for its own screenshots. Pick another.`
  return null
}
