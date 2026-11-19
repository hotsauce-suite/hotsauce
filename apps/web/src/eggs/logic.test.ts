import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { type Command, matchCommands } from '../keyboard/commands'
import { HOT_SAUCE_DAY_LINE, isHotSauceDay, isSpicy, KONAMI, konamiTracker } from './logic'

const feed = (keys: readonly string[]) => {
  const track = konamiTracker()
  return keys.map((k) => track(k))
}

describe('Konami code (E1)', () => {
  it('fires on the last key of the code, once', () => {
    const hits = feed(KONAMI)
    expect(hits.at(-1)).toBe(true)
    expect(hits.slice(0, -1).every((h) => !h)).toBe(true)
  })

  it('takes capital B and A (Shift held)', () => {
    expect(feed([...KONAMI.slice(0, 8), 'B', 'A']).at(-1)).toBe(true)
  })

  it('still fires after extra ups at the start, or after a false start', () => {
    expect(feed(['ArrowUp', ...KONAMI]).at(-1)).toBe(true)
    expect(feed(['ArrowUp', 'ArrowUp', 'ArrowDown', 'x', ...KONAMI]).at(-1)).toBe(true)
  })

  it('never fires for keys that miss any step', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: KONAMI.length - 1 }),
        fc.string({ minLength: 1, maxLength: 1 }),
        (i, wrong) => {
          fc.pre(wrong.toLowerCase() !== KONAMI[i] && wrong !== KONAMI[i])
          const keys: string[] = [...KONAMI]
          keys[i] = wrong
          return !feed(keys).some(Boolean)
        },
      ),
    )
  })

  it('fires again the second time through', () => {
    expect(feed([...KONAMI, ...KONAMI]).filter(Boolean)).toHaveLength(2)
  })
})

describe('Spicy tasks (E5)', () => {
  it('knows a pepper or "hot sauce", in any case, and not the product name', () => {
    expect(isSpicy('Buy 🌶 sauce')).toBe(true)
    expect(isSpicy('Restock HOT SAUCE')).toBe(true)
    expect(isSpicy('hot-sauce tasting')).toBe(true)
    expect(isSpicy('Fix the Hotsauce sign-in')).toBe(false)
    expect(isSpicy('Hot take on sauces')).toBe(false)
    expect(isSpicy('Write the plan')).toBe(false)
  })
})

describe('National Hot Sauce Day (E7)', () => {
  it('is January 22 only, by the local calendar', () => {
    expect(isHotSauceDay(new Date(2027, 0, 22, 0, 1))).toBe(true)
    expect(isHotSauceDay(new Date(2027, 0, 22, 23, 59))).toBe(true)
    expect(isHotSauceDay(new Date(2027, 0, 21, 23, 59))).toBe(false)
    expect(isHotSauceDay(new Date(2027, 1, 22))).toBe(false)
    expect(HOT_SAUCE_DAY_LINE).toContain('Hot Sauce Day')
  })
})

describe('Secret ⌘K phrases (E3)', () => {
  const run = () => {}
  const secret: Command = {
    id: 'more',
    title: 'More heat',
    group: 'prefs',
    secret: ['more heat'],
    run,
  }
  const normal: Command = { id: 'dark', title: 'Dark theme', group: 'prefs', run }
  const ask: Command = { id: 'ask', title: 'Ask', group: 'ask', anyQuery: true, run }
  const all = [secret, normal, ask]

  it('shows only for the exact phrase, whatever the case and spacing', () => {
    expect(matchCommands(all, 'more heat')).toContain(secret)
    expect(matchCommands(all, '  More   HEAT ')).toContain(secret)
  })

  it('hides from the empty menu, from partial phrases and from its own title words', () => {
    for (const query of ['', 'more', 'more hea', 'heat', 'prefer', 'more heat please']) {
      expect(matchCommands(all, query)).not.toContain(secret)
    }
    expect(matchCommands(all, '')).toContain(normal)
  })
})
