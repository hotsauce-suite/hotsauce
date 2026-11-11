import { describe, expect, it } from 'vitest'
import { type Invoked, meetCode, pickTarget, remember, UNMATCHED_MS } from './meet'

describe('meetCode', () => {
  it('reads the code of a Meet call', () => {
    expect(meetCode('https://meet.google.com/abc-defg-hij')).toBe('abc-defg-hij')
    expect(meetCode('https://meet.google.com/abc-defg-hij?authuser=1')).toBe('abc-defg-hij')
    expect(meetCode('https://meet.google.com/abc-defg-hij/')).toBe('abc-defg-hij')
  })

  it('is null for Meet pages that are not a call, and for other sites', () => {
    expect(meetCode('https://meet.google.com/')).toBeNull()
    expect(meetCode('https://meet.google.com/landing')).toBeNull()
    expect(meetCode('https://meet.google.com/abc-defg-hijk')).toBeNull()
    expect(meetCode('https://evil.example/https://meet.google.com/abc-defg-hij')).toBeNull()
    expect(meetCode('http://meet.google.com/abc-defg-hij')).toBeNull()
    expect(meetCode(undefined)).toBeNull()
  })
})

describe('invoked tabs', () => {
  const a: Invoked = { tabId: 1, code: 'aaa-aaaa-aaa', at: 100 }
  const b: Invoked = { tabId: 2, code: 'bbb-bbbb-bbb', at: 200 }
  const urls: Record<number, string> = {
    1: 'https://meet.google.com/aaa-aaaa-aaa',
    2: 'https://meet.google.com/bbb-bbbb-bbb',
  }
  const urlOf = async (id: number) => urls[id]

  it('keeps one entry per tab, newest first', () => {
    const list = remember(remember([a], b), { ...a, at: 300 })
    expect(list.map((e) => [e.tabId, e.at])).toEqual([
      [1, 300],
      [2, 200],
    ])
  })

  it('keeps only the last ten', () => {
    let list: Invoked[] = []
    for (let i = 0; i < 15; i++) list = remember(list, { tabId: i, code: 'x', at: i })
    expect(list).toHaveLength(10)
    expect(list[0]?.tabId).toBe(14)
  })

  const soon = { code: null, now: 300 }

  it('picks the tab on the page’s call, however long ago it was clicked', async () => {
    const later = 200 + 5 * UNMATCHED_MS
    expect(await pickTarget([a, b], { code: 'aaa-aaaa-aaa', now: later }, urlOf)).toEqual(a)
    expect(await pickTarget([a, b], { code: 'ccc-cccc-ccc', now: 300 }, urlOf)).toBeNull()
    expect(await pickTarget([a, b], { code: '', now: 300 }, urlOf)).toBeNull()
  })

  it('without a call to match, picks the newest tab, only if it was clicked just now', async () => {
    expect(await pickTarget([a, b], soon, urlOf)).toEqual(b)
    expect(await pickTarget([], soon, urlOf)).toBeNull()
    // A call left open from this morning is never recorded by mistake.
    expect(await pickTarget([a, b], { code: null, now: 201 + UNMATCHED_MS }, urlOf)).toBeNull()
  })

  it('skips a tab that closed or left the call', async () => {
    const moved = async (id: number) => (id === 2 ? 'https://meet.google.com/' : urls[id])
    expect(await pickTarget([a, b], soon, moved)).toEqual(a)
    const closed = async (id: number) => (id === 1 ? undefined : urls[id])
    expect(await pickTarget([a], soon, closed)).toBeNull()
    const elsewhere = async (id: number) => (id === 1 ? urls[2] : urls[id])
    expect(await pickTarget([a], { code: 'bbb-bbbb-bbb', now: 300 }, elsewhere)).toBeNull()
  })
})
