import { describe, expect, it } from 'vitest'
import { RESERVED, SECTIONS, SHORTCUTS, shortcutIds } from './catalog'
import { parseSpec, strokeId } from './keys'

const canonical = (spec: string) => parseSpec(spec).map(strokeId).join(' ')

describe('the shortcut list (K3)', () => {
  it('parses every key spec', () => {
    for (const id of shortcutIds)
      for (const spec of SHORTCUTS[id].keys) expect(() => parseSpec(spec)).not.toThrow()
  })

  it('never takes a browser- or Mac-owned key', () => {
    const reserved = new Set(RESERVED.map(canonical))
    for (const id of shortcutIds) {
      for (const spec of SHORTCUTS[id].keys) {
        expect(reserved.has(canonical(spec)), `${id} uses ${spec}`).toBe(false)
      }
    }
  })

  it('gives no two listener-bound shortcuts the same keys where both can be live', () => {
    const bound = shortcutIds.filter((id) => !SHORTCUTS[id].handledBy)
    const clashes: string[] = []
    for (const a of bound) {
      for (const b of bound) {
        if (a >= b) continue
        const sa = SHORTCUTS[a]
        const sb = SHORTCUTS[b]
        // Sections of different apps are never on screen together; Everywhere is always there.
        const together =
          sa.section === sb.section || sa.section === 'everywhere' || sb.section === 'everywhere'
        if (!together) continue
        for (const ka of sa.keys.map(canonical)) {
          for (const kb of sb.keys.map(canonical)) {
            // Same keys, or one is the first key of the other's sequence ("g" vs "g d").
            if (ka === kb || kb.startsWith(`${ka} `) || ka.startsWith(`${kb} `))
              clashes.push(`${a} ${ka} / ${b} ${kb}`)
          }
        }
      }
    }
    expect(clashes).toEqual([])
  })

  it('files every shortcut under a known section', () => {
    for (const id of shortcutIds) expect(SECTIONS[SHORTCUTS[id].section]).toBeDefined()
  })
})
