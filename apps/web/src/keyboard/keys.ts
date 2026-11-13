// Key specs, matching and keycaps. Pure: no DOM beyond reading a KeyboardEvent's fields.
//
// A spec is one or more strokes separated by spaces ("g d" is g, then d). A stroke is
// modifiers and a key joined by "+": "mod+k", "alt+mod+1", "shift+mod+8", "?", "ArrowDown".
// `mod` is ⌘ on a Mac and Ctrl elsewhere (either is accepted, as Cmd-K always was).

export interface Stroke {
  key: string
  mod: boolean
  alt: boolean
  shift: boolean
}

/** The fields of a KeyboardEvent that matching reads. */
export interface KeyInput {
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

const ALIASES: Record<string, string> = {
  space: ' ',
  esc: 'escape',
  del: 'delete',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  return: 'enter',
}

function normalizeKey(key: string): string {
  const lower = key.length === 1 ? key.toLowerCase() : key.toLowerCase()
  return ALIASES[lower] ?? lower
}

export function parseStroke(text: string): Stroke {
  // "+" itself is a key: "mod++" or "+". Split on "+" that separates parts.
  const parts =
    text === '+'
      ? ['+']
      : text.endsWith('++')
        ? [...text.slice(0, -2).split('+'), '+']
        : text.split('+')
  const stroke: Stroke = { key: '', mod: false, alt: false, shift: false }
  for (const part of parts) {
    const p = part.toLowerCase()
    if (p === 'mod' || p === 'cmd' || p === 'ctrl' || p === 'meta') stroke.mod = true
    else if (p === 'alt' || p === 'option') stroke.alt = true
    else if (p === 'shift') stroke.shift = true
    else stroke.key = normalizeKey(part)
  }
  if (!stroke.key) throw new Error(`Key spec "${text}" has no key`)
  return stroke
}

export function parseSpec(spec: string): Stroke[] {
  return spec.trim().split(/\s+/).map(parseStroke)
}

const isLetter = (key: string) => /^[a-z]$/.test(key)
const isDigit = (key: string) => /^[0-9]$/.test(key)
/** A printed character other than a letter or digit: its Shift is part of the character. */
const isSymbol = (key: string) => key.length === 1 && !isLetter(key) && !isDigit(key) && key !== ' '

/** True when `input` is this one stroke. */
export function matchStroke(stroke: Stroke, input: KeyInput): boolean {
  const mod = input.metaKey || input.ctrlKey
  if (mod !== stroke.mod || input.altKey !== stroke.alt) return false
  let key = normalizeKey(input.key)
  // With Alt held a Mac types another character (⌥1 is ¡), and a non-Latin layout types its
  // own letter for Ctrl-K (л): fall back to the physical key, but only for a key that isn't
  // already ASCII, so Dvorak and AZERTY keep their own letters.
  if ((input.altKey || mod) && input.code && !/^[\x20-\x7e]$/.test(key)) {
    const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(input.code)
    if (m) key = (m[1] ?? m[2] ?? '').toLowerCase()
  }
  if (key !== stroke.key) return false
  // "?" is Shift+/ on most layouts and plain on others: the character is what counts.
  if (isSymbol(stroke.key)) return true
  return input.shiftKey === stroke.shift
}

/** A key a person types as text: letters, digits, symbols, Space. WCAG 2.1.4's "character keys". */
export function isCharacterStroke(stroke: Stroke): boolean {
  return !stroke.mod && !stroke.alt && stroke.key.length === 1
}

/** True when every stroke is free of ⌘/Ctrl and Alt: the key fires only outside text fields. */
export function isPlainSpec(strokes: Stroke[]): boolean {
  return strokes.every((s) => !s.mod && !s.alt)
}

export function isMac(
  platform = typeof navigator === 'undefined' ? '' : navigator.platform,
): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform)
}

const NAMES: Record<string, string> = {
  ' ': 'Space',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  enter: 'Enter',
  escape: 'Esc',
  delete: 'Delete',
  backspace: 'Backspace',
  tab: 'Tab',
}

function keyName(key: string): string {
  if (NAMES[key]) return NAMES[key]
  if (/^f[0-9]{1,2}$/.test(key)) return key.toUpperCase()
  return key.length === 1 ? key : key[0]?.toUpperCase() + key.slice(1)
}

/**
 * The keycaps of one stroke: on a Mac ["⌥⌘1"] style glyphs joined, elsewhere "Ctrl+Alt+1".
 * Letters with a modifier are capitals (⌘K); a plain letter stays as typed (g).
 */
export function formatStroke(stroke: Stroke, mac = isMac()): string {
  const withMod = stroke.mod || stroke.alt || stroke.shift
  const name = keyName(stroke.key)
  const key = withMod && name.length === 1 ? name.toUpperCase() : name
  if (mac) {
    return `${stroke.shift && !isSymbol(stroke.key) ? '⇧' : ''}${stroke.alt ? '⌥' : ''}${stroke.mod ? '⌘' : ''}${key}`
  }
  const parts = [
    ...(stroke.mod ? ['Ctrl'] : []),
    ...(stroke.alt ? ['Alt'] : []),
    ...(stroke.shift && !isSymbol(stroke.key) ? ['Shift'] : []),
    key,
  ]
  return parts.join('+')
}

/** Keycaps for a whole spec, one per stroke: "g d" → ["g", "d"]. */
export function formatSpec(spec: string, mac = isMac()): string[] {
  return parseSpec(spec).map((s) => formatStroke(s, mac))
}

/** The `aria-keyshortcuts` value for a spec (only single strokes can be expressed). */
export function ariaKeys(spec: string, mac = isMac()): string | undefined {
  const strokes = parseSpec(spec)
  if (strokes.length !== 1) return undefined
  const [s] = strokes as [Stroke]
  const name = s.key === ' ' ? 'Space' : s.key.length === 1 ? s.key.toUpperCase() : keyName(s.key)
  return [
    ...(s.mod ? [mac ? 'Meta' : 'Control'] : []),
    ...(s.alt ? ['Alt'] : []),
    ...(s.shift ? ['Shift'] : []),
    name === '↑'
      ? 'ArrowUp'
      : name === '↓'
        ? 'ArrowDown'
        : name === '←'
          ? 'ArrowLeft'
          : name === '→'
            ? 'ArrowRight'
            : name,
  ].join('+')
}

/** A canonical string for a stroke, for comparing specs: "mod+shift+8". */
export function strokeId(stroke: Stroke): string {
  return `${stroke.mod ? 'mod+' : ''}${stroke.alt ? 'alt+' : ''}${stroke.shift && !isSymbol(stroke.key) ? 'shift+' : ''}${stroke.key}`
}

/** True when an element takes typed text, so plain keys belong to it. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  // jsdom has no isContentEditable; the attribute says the same.
  if (target.closest('[contenteditable]:not([contenteditable="false"])')) return true
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true
  if (target instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(target.type)
  }
  return false
}
