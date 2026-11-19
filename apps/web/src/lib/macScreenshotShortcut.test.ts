import { describe, expect, it } from 'vitest'
import { chordFromKey, chordRefusal, keyName } from './macScreenshotShortcut'

// docs/PLAN-screenshots.md R15: the same text and rules as apps/dictate-mac ScreenshotShortcut.

const press = (
  code: string,
  mods: Partial<Record<'meta' | 'ctrl' | 'alt' | 'shift', boolean>> = {},
) => ({
  code,
  metaKey: !!mods.meta,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
})

describe('the screenshot shortcut recorder', () => {
  it('writes a chord as the Mac does, modifiers in Apple’s order', () => {
    expect(chordFromKey(press('Digit4', { alt: true, shift: true }))).toBe('⌥⇧4')
    expect(chordFromKey(press('KeyS', { meta: true, shift: true, ctrl: true, alt: true }))).toBe(
      '⌃⌥⇧⌘S',
    )
    expect(chordFromKey(press('Space', { ctrl: true }))).toBe('⌃Space')
    expect(chordFromKey(press('F12', { alt: true }))).toBe('⌥F12')
    expect(chordFromKey(press('ArrowUp', { ctrl: true, alt: true }))).toBe('⌃⌥↑')
  })

  it('waits while only modifiers are down', () => {
    expect(chordFromKey(press('AltRight', { alt: true }))).toBeNull()
    expect(chordFromKey(press('ShiftLeft', { shift: true }))).toBeNull()
    expect(chordFromKey(press('MetaLeft', { meta: true }))).toBeNull()
    expect(keyName('Escape')).toBeNull()
  })

  it('refuses plain keys, ⇧ alone, ⌘ alone and macOS’s own screenshot keys', () => {
    expect(chordRefusal('⌥⇧4')).toBeNull()
    expect(chordRefusal('⌃⌥S')).toBeNull()
    expect(chordRefusal('⇧⌘S')).toBeNull()
    expect(chordRefusal('4')).toMatch(/Add ⌘, ⌥ or ⌃/)
    expect(chordRefusal('⇧4')).toMatch(/Add ⌘, ⌥ or ⌃/)
    expect(chordRefusal('⌘C')).toMatch(/⌘C/)
    expect(chordRefusal('⇧⌘4')).toMatch(/macOS uses ⇧⌘4/)
    expect(chordRefusal('⌥⇧')).toMatch(/Press a key/)
  })
})
