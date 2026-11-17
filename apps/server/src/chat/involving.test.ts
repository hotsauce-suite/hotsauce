import { describe, expect, it } from 'vitest'
import { chatInvolving } from './involving.js'
import type { ChatMessage } from './store.js'

const message = (text: string, author = 'Casey'): ChatMessage => ({
  room: 'r1',
  id: text,
  thread: null,
  createdAt: '2026-11-16T10:00:00.000Z',
  author,
  text,
  url: '',
})

const involving = (messages: ChatMessage[]) =>
  chatInvolving(
    { readTargets: () => [{ id: 'r1', name: 'General', messagesUrl: '' }] },
    { since: () => messages },
  )({ name: 'Will Chen', email: 'will@example.test' }, new Date(0)).map((m) => m.text)

describe('chat messages for a brief', () => {
  it('matches a first name only as a name', () => {
    expect(
      involving([
        message('Will, can you take this?'),
        message('ask @will about it'),
        message('we will see tomorrow'),
        message('Will Chen joins Monday'),
        message('Willow is here'),
        message('my own words', 'Will Chen'),
      ]),
    ).toEqual([
      'Will, can you take this?',
      'ask @will about it',
      'Will Chen joins Monday',
      'my own words',
    ])
  })
})
