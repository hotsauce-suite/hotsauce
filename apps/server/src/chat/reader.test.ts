import { describe, expect, it } from 'vitest'
import { messagesUrlOf } from '../forms/index.js'
import { nextCursor, parseMessages } from './reader.js'
import { ChatStore } from './store.js'

describe('messagesUrlOf', () => {
  it('turns a bot room webhook into its read address', () => {
    expect(messagesUrlOf('https://chat.example.test/rooms/general/7-abc/slack')).toBe(
      'https://chat.example.test/rooms/general/7-abc/messages',
    )
  })
  it('refuses Slack, http and anything else', () => {
    expect(messagesUrlOf('https://hooks.slack.com/services/T/B/x')).toBeNull()
    expect(messagesUrlOf('http://chat.example.test/rooms/general/7-abc/slack')).toBeNull()
    expect(messagesUrlOf('not a url')).toBeNull()
  })
})

describe('nextCursor', () => {
  it('takes only the cursor from a next link', () => {
    expect(nextCursor('<https://x.test/rooms/a/k/messages?before=42>; rel="next"')).toEqual({
      kind: 'before',
      id: '42',
    })
    expect(nextCursor('<https://x.test/m?after=9>; rel=next')).toEqual({ kind: 'after', id: '9' })
    expect(nextCursor('<https://x.test/m?before=1>; rel="prev"')).toBeNull()
    expect(nextCursor(null)).toBeNull()
  })
})

describe('parseMessages', () => {
  it('keeps text or a file name, skips malformed rows and links carrying the key', () => {
    const out = parseMessages(
      'r',
      [
        {
          id: 1,
          created_at: '2026-11-01T10:00:00Z',
          body: { plain_text: ' hi ' },
          creator: { name: 'A' },
          url: 'https://c.test/rooms/g/@1',
        },
        {
          id: 2,
          created_at: '2026-11-01T10:01:00Z',
          body: { plain_text: '' },
          attachment: { filename: 'plan.pdf' },
          url: 'https://c.test/rooms/g/KEY/x',
        },
        { id: 3, created_at: 'nope', body: { plain_text: 'x' } },
        null,
      ],
      null,
      'KEY',
    )
    expect(out).toEqual([
      {
        room: 'r',
        id: '1',
        thread: null,
        createdAt: '2026-11-01T10:00:00.000Z',
        author: 'A',
        text: 'hi',
        url: 'https://c.test/rooms/g/@1',
      },
      {
        room: 'r',
        id: '2',
        thread: null,
        createdAt: '2026-11-01T10:01:00.000Z',
        author: 'Someone',
        text: '[file: plan.pdf]',
        url: '',
      },
    ])
  })
  it('refuses an answer that is not a list', () => {
    expect(() => parseMessages('r', { error: 'x' }, null)).toThrow(/isn’t messages/)
  })
})

describe('ChatStore', () => {
  const msg = (id: string, at: string, text: string, room = 'r') => ({
    room,
    id,
    thread: null,
    createdAt: at,
    author: 'Rajiv',
    text,
    url: '',
  })
  it('searches, pages and forgets rooms', () => {
    const store = new ChatStore(':memory:')
    store.upsert([
      msg('1', '2026-11-01T00:00:00.000Z', 'freezer alarm'),
      msg('2', '2026-11-02T00:00:00.000Z', 'freezer fixed'),
      msg('3', '2026-11-03T00:00:00.000Z', 'freezer in another room', 'other'),
    ])
    expect(
      store
        .search('freezer', { rooms: ['r'] })
        .map((h) => h.id)
        .sort(),
    ).toEqual(['1', '2'])
    expect(store.search('freezer', { rooms: [] })).toEqual([])
    expect(store.search('"', { rooms: ['r'] })).toEqual([])
    expect(store.search('freezer', { rooms: ['r'], since: '2026-11-02' }).map((h) => h.id)).toEqual(
      ['2'],
    )
    expect(store.messages('r', { limit: 1 }).map((m) => m.id)).toEqual(['2'])
    expect(store.messages('r', { before: '2026-11-02T00:00:00.000Z' }).map((m) => m.id)).toEqual([
      '1',
    ])
    store.upsert([msg('1', '2026-11-01T00:00:00.000Z', 'alarm edited')])
    expect(store.search('freezer', { rooms: ['r'] }).map((h) => h.id)).toEqual(['2'])
    store.drop('r')
    expect(store.count('r')).toBe(0)
    expect(store.count('other')).toBe(1)
    store.close()
  })
})
