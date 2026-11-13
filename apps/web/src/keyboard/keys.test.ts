import { describe, expect, it } from 'vitest'
import {
  ariaKeys,
  formatSpec,
  isCharacterStroke,
  type KeyInput,
  matchStroke,
  parseSpec,
  parseStroke,
} from './keys'

const press = (key: string, mods: Partial<KeyInput> = {}): KeyInput => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
})

describe('parse (K1)', () => {
  it('reads modifiers, keys and sequences', () => {
    expect(parseStroke('mod+k')).toEqual({ key: 'k', mod: true, alt: false, shift: false })
    expect(parseStroke('shift+mod+8')).toEqual({ key: '8', mod: true, alt: false, shift: true })
    expect(parseStroke('Space').key).toBe(' ')
    expect(parseStroke('ArrowDown').key).toBe('arrowdown')
    expect(parseSpec('g d').map((s) => s.key)).toEqual(['g', 'd'])
    expect(parseStroke('mod++').key).toBe('+')
  })

  it('rejects a spec with no key', () => {
    expect(() => parseStroke('mod+shift')).toThrow()
  })
})

describe('match (K1)', () => {
  const k = parseStroke('mod+k')
  it('accepts ⌘ or Ctrl for mod', () => {
    expect(matchStroke(k, press('k', { metaKey: true }))).toBe(true)
    expect(matchStroke(k, press('K', { ctrlKey: true }))).toBe(true)
    expect(matchStroke(k, press('k'))).toBe(false)
    expect(matchStroke(k, press('k', { metaKey: true, altKey: true }))).toBe(false)
  })

  it('a plain letter needs no modifiers, and Shift makes it another key', () => {
    const j = parseStroke('j')
    expect(matchStroke(j, press('j'))).toBe(true)
    expect(matchStroke(j, press('J', { shiftKey: true }))).toBe(false)
    expect(matchStroke(j, press('j', { metaKey: true }))).toBe(false)
  })

  it('a symbol matches whatever Shift it took to type', () => {
    const help = parseStroke('?')
    expect(matchStroke(help, press('?', { shiftKey: true }))).toBe(true)
    expect(matchStroke(help, press('?'))).toBe(true)
  })

  it('with Alt held, letters and digits match by physical key', () => {
    const h1 = parseStroke('alt+mod+1')
    expect(matchStroke(h1, press('¡', { code: 'Digit1', altKey: true, metaKey: true }))).toBe(true)
    expect(matchStroke(h1, press('™', { code: 'Digit2', altKey: true, metaKey: true }))).toBe(false)
  })

  it('every letter, digit and symbol spec matches its own plain press', () => {
    for (const ch of 'abcdefghijklmnopqrstuvwxyz0123456789/?<>[]') {
      expect(matchStroke(parseStroke(ch), press(ch))).toBe(true)
    }
  })
})

describe('format (K2)', () => {
  it('uses Mac glyphs on a Mac', () => {
    expect(formatSpec('mod+k', true)).toEqual(['⌘K'])
    expect(formatSpec('alt+mod+1', true)).toEqual(['⌥⌘1'])
    expect(formatSpec('shift+mod+z', true)).toEqual(['⇧⌘Z'])
    expect(formatSpec('g d', true)).toEqual(['g', 'd'])
    expect(formatSpec('?', true)).toEqual(['?'])
    expect(formatSpec('ArrowDown', true)).toEqual(['↓'])
    expect(formatSpec('Space', true)).toEqual(['Space'])
  })

  it('spells out modifiers elsewhere', () => {
    expect(formatSpec('mod+k', false)).toEqual(['Ctrl+K'])
    expect(formatSpec('alt+mod+1', false)).toEqual(['Ctrl+Alt+1'])
    expect(formatSpec('shift+mod+z', false)).toEqual(['Ctrl+Shift+Z'])
    expect(formatSpec('mod+Enter', false)).toEqual(['Ctrl+Enter'])
  })

  it('names keys for screen readers', () => {
    expect(ariaKeys('mod+k', true)).toBe('Meta+K')
    expect(ariaKeys('mod+k', false)).toBe('Control+K')
    expect(ariaKeys('g d', true)).toBeUndefined()
    expect(ariaKeys('ArrowDown', true)).toBe('ArrowDown')
  })
})

describe('character keys (K6)', () => {
  it('are letters, digits, symbols and Space without ⌘ or Alt', () => {
    expect(isCharacterStroke(parseStroke('j'))).toBe(true)
    expect(isCharacterStroke(parseStroke('?'))).toBe(true)
    expect(isCharacterStroke(parseStroke('Space'))).toBe(true)
    expect(isCharacterStroke(parseStroke('mod+k'))).toBe(false)
    expect(isCharacterStroke(parseStroke('ArrowDown'))).toBe(false)
    expect(isCharacterStroke(parseStroke('Enter'))).toBe(false)
  })
})
