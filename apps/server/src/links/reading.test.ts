import { describe, expect, it } from 'vitest'
import { MAX_ANCHOR, ReadingStore } from './reading.js'

describe('ReadingStore', () => {
  const at = new Date('2026-11-15T12:00:00Z')

  it('keeps one place per member and link, with the furthest point reached', () => {
    const store = new ReadingStore(':memory:')
    expect(store.get('u1', 'L1')).toBeNull()
    store.set('u1', 'L1', { anchor: 10, percent: 60 }, at)
    store.set('u1', 'L1', { anchor: 1, percent: 5 }, at)
    store.set('u2', 'L1', { anchor: 3, percent: 20 }, at)
    expect(store.get('u1', 'L1')).toEqual({
      anchor: 1,
      percent: 5,
      furthest: 60,
      updated: at.toISOString(),
    })
    expect(store.get('u2', 'L1')?.furthest).toBe(20)
    expect([...store.allFor('u1').keys()]).toEqual(['L1'])
    store.close()
  })

  it('clamps what it is given into range', () => {
    const store = new ReadingStore(':memory:')
    expect(store.set('u', 'L', { anchor: -4, percent: -1 })).toMatchObject({
      anchor: 0,
      percent: 0,
    })
    expect(store.set('u', 'L', { anchor: 1e9, percent: 250 })).toMatchObject({
      anchor: MAX_ANCHOR,
      percent: 100,
      furthest: 100,
    })
    expect(store.set('u', 'L', { anchor: 2.7, percent: Number.NaN })).toMatchObject({
      anchor: 2,
      percent: 0,
      furthest: 100,
    })
    store.close()
  })

  it('forgets every member’s place in a deleted link', () => {
    const store = new ReadingStore(':memory:')
    store.set('u1', 'L1', { anchor: 1, percent: 10 })
    store.set('u2', 'L1', { anchor: 1, percent: 10 })
    store.set('u1', 'L2', { anchor: 1, percent: 10 })
    store.forget('L1')
    expect(store.get('u1', 'L1')).toBeNull()
    expect(store.get('u2', 'L1')).toBeNull()
    expect(store.get('u1', 'L2')).not.toBeNull()
    store.close()
  })
})
