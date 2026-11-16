import { describe, expect, it } from 'vitest'
import {
  emptyForYouState,
  FOR_YOU_STATE_PATH,
  forYouStanding,
  laterUntil,
  MAX_FOR_YOU_MARKS,
  markForYou,
  parseForYouState,
  serializeForYouState,
} from './for-you.js'

const ITEM = '01JQ0000000000000000000001'
const t = (iso: string) => new Date(iso)

describe('the For you state file (R17)', () => {
  it('lives in the member’s .hearth folder and round-trips', () => {
    expect(FOR_YOU_STATE_PATH).toBe('.hearth/for-you.json')
    const state = markForYou(
      emptyForYouState(),
      ITEM,
      { action: 'seen' },
      t('2026-11-16T10:00:00Z'),
    )
    const text = serializeForYouState(state)
    expect(text.endsWith('\n')).toBe(true)
    expect(parseForYouState(text)).toEqual(state)
  })

  it('reads anything else as empty, and drops what it does not understand', () => {
    expect(parseForYouState('not json')).toEqual(emptyForYouState())
    expect(parseForYouState({ schema: 2, items: {} })).toEqual(emptyForYouState())
    const state = parseForYouState({
      schema: 1,
      items: {
        [ITEM]: { seen: '2026-11-16T10:00:00Z', done: 'yesterday', following: true },
        '../etc': { seen: '2026-11-16T10:00:00Z' },
        other: 'nope',
        empty: { done: 7 },
      },
    })
    expect(state).toEqual({ schema: 1, items: { [ITEM]: { seen: '2026-11-16T10:00:00.000Z' } } })
  })

  it('keeps the most recently touched marks when there are too many', () => {
    let state = emptyForYouState()
    for (let i = 0; i < MAX_FOR_YOU_MARKS + 5; i++) {
      const at = new Date(Date.UTC(2026, 0, 1) + i * 60_000)
      state = markForYou(state, `item-${String(i).padStart(5, '0')}`, { action: 'seen' }, at)
    }
    const kept = Object.keys(parseForYouState(serializeForYouState(state)).items)
    expect(kept).toHaveLength(MAX_FOR_YOU_MARKS)
    expect(kept).not.toContain('item-00000')
    expect(kept).toContain(`item-${String(MAX_FOR_YOU_MARKS + 4).padStart(5, '0')}`)
  })
})

describe('what shows and what counts (R14, R15, R16)', () => {
  const now = t('2026-11-16T12:00:00Z')
  const mention = '2026-11-16T11:00:00Z'

  it('a new mention shows and counts; opening it stops the count but keeps it listed', () => {
    expect(forYouStanding(undefined, mention, now)).toEqual({
      shown: true,
      at: '2026-11-16T11:00:00.000Z',
      unseen: true,
    })
    const seen = markForYou(emptyForYouState(), ITEM, { action: 'seen' }, now).items[ITEM]
    expect(forYouStanding(seen, mention, now)).toMatchObject({ shown: true, unseen: false })
    // Something newer counts again.
    expect(forYouStanding(seen, '2026-11-16T12:30:00Z', now)).toMatchObject({ unseen: true })
  })

  it('Done hides it until a newer mention, which brings it back', () => {
    const done = markForYou(emptyForYouState(), ITEM, { action: 'done' }, now).items[ITEM]
    expect(forYouStanding(done, mention, now)).toEqual({ shown: false })
    expect(forYouStanding(done, '2026-11-16T12:05:00Z', now)).toMatchObject({
      shown: true,
      unseen: true,
    })
    const undone = markForYou(
      { schema: 1, items: { [ITEM]: done as object } },
      ITEM,
      { action: 'undone' },
      now,
    )
    expect(undone.items[ITEM]).toBeUndefined()
  })

  it('Later hides it until its time, then it is back at the top and counts', () => {
    const until = '2026-11-17T14:00:00.000Z'
    let state = markForYou(emptyForYouState(), ITEM, { action: 'seen' }, now)
    state = markForYou(state, ITEM, { action: 'later', until }, now)
    const mark = state.items[ITEM]
    expect(forYouStanding(mark, mention, now)).toEqual({ shown: false })
    expect(forYouStanding(mark, mention, t('2026-11-17T13:59:00Z'))).toEqual({ shown: false })
    expect(forYouStanding(mark, mention, t('2026-11-17T14:00:00Z'))).toEqual({
      shown: true,
      at: until,
      unseen: true,
    })
    // A mention after Later was chosen brings it back at once.
    expect(forYouStanding(mark, '2026-11-16T15:00:00Z', t('2026-11-16T16:00:00Z'))).toMatchObject({
      shown: true,
      unseen: true,
    })
    // Once they open it, the Later is over: it doesn't come round again at 9 AM.
    const opened = markForYou(state, ITEM, { action: 'seen' }, t('2026-11-16T16:00:00Z')).items[
      ITEM
    ]
    expect(forYouStanding(opened, '2026-11-16T15:00:00Z', t('2026-11-17T14:30:00Z'))).toEqual({
      shown: true,
      at: '2026-11-16T15:00:00.000Z',
      unseen: false,
    })
  })

  it('Done after Later drops the Later', () => {
    let state = markForYou(
      emptyForYouState(),
      ITEM,
      { action: 'later', until: '2026-11-17T14:00:00Z' },
      now,
    )
    state = markForYou(state, ITEM, { action: 'done' }, now)
    expect(state.items[ITEM]).toEqual({ done: now.toISOString() })
  })
})

describe('Later’s time: 9 AM in the member’s zone (R16)', () => {
  it('tomorrow is 9 AM the next day there', () => {
    // 22:30 on Sunday 15 Nov in New York (03:30Z Monday).
    const now = t('2026-11-16T03:30:00Z')
    expect(laterUntil('tomorrow', now, 'America/New_York').toISOString()).toBe(
      '2026-11-16T14:00:00.000Z',
    )
    expect(laterUntil('tomorrow', now, 'Europe/London').toISOString()).toBe(
      '2026-11-17T09:00:00.000Z',
    )
  })

  it('next Monday is the coming Monday, or a week on from a Monday', () => {
    // Sunday evening in New York: tomorrow is Monday.
    expect(laterUntil('monday', t('2026-11-16T03:30:00Z'), 'America/New_York').toISOString()).toBe(
      '2026-11-16T14:00:00.000Z',
    )
    // Monday in London: a week on.
    expect(laterUntil('monday', t('2026-11-16T08:00:00Z'), 'Europe/London').toISOString()).toBe(
      '2026-11-23T09:00:00.000Z',
    )
    // Wednesday.
    expect(laterUntil('monday', t('2026-11-18T12:00:00Z'), 'Asia/Kolkata').toISOString()).toBe(
      '2026-11-23T03:30:00.000Z',
    )
  })

  it('crosses a clock change at the right offset', () => {
    // Saturday 7 Mar 2026 in New York; Daylight time starts Sunday 8 Mar.
    expect(laterUntil('monday', t('2026-03-07T15:00:00Z'), 'America/New_York').toISOString()).toBe(
      '2026-03-09T13:00:00.000Z',
    )
  })
})
