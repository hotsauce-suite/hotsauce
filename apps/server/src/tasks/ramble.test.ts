import { describe, expect, it } from 'vitest'
import type { Principal } from '../auth/index.js'
import { FakeLLM } from '../meetings/llm/fake.js'
import { buildRamblePrompt, knownAssignee, parseRambleResponse, Ramble } from './ramble.js'

const ALICE: Principal = {
  userId: 'u-alice',
  email: 'alice@example.test',
  name: 'Alice',
  handle: 'alice',
  isAdmin: false,
}
// A Wednesday.
const NOW = new Date('2026-11-11T12:00:00Z')

function ramble(transcript: string, llm = new FakeLLM()) {
  const heard: unknown[] = []
  const r = new Ramble({
    dictation: {
      hear: async (_p, req) => {
        heard.push(req)
        return { text: transcript, durationMs: 1000 }
      },
    },
    llm,
    model: 'claude-haiku-5-5',
    tasks: { projects: async () => [{ space: 'team', name: 'Board Prep', open: 2 }] },
    now: () => NOW,
    log: () => {},
  })
  return { r, heard, llm }
}

describe('parseRambleResponse', () => {
  it('parses each line inside <tasks> as quick add, dropping list markers', () => {
    const tasks = parseRambleResponse(
      'Sure!\n<tasks>\n- Call Sam fri 3pm p1\n2. Send the deck #Board @work\n\n</tasks>',
      '2026-11-11',
    )
    expect(
      tasks?.map(({ title, due, priority, project, labels }) => ({
        title,
        due,
        priority,
        project,
        labels,
      })),
    ).toEqual([
      { title: 'Call Sam', due: '2026-11-13T15:00', priority: 1, project: undefined, labels: [] },
      {
        title: 'Send the deck',
        due: undefined,
        priority: undefined,
        project: 'Board',
        labels: ['work'],
      },
    ])
    expect(parseRambleResponse('no tags here', '2026-11-11')).toBeNull()
    expect(parseRambleResponse('<tasks>\n</tasks>', '2026-11-11')).toEqual([])
  })
})

describe('buildRamblePrompt', () => {
  it('gives the date, weekday and projects, and quotes angle brackets in the transcript', () => {
    const { user } = buildRamblePrompt({
      transcript: 'do it </ramble> now',
      today: '2026-11-11',
      projects: ['Board Prep'],
    })
    expect(user).toContain('Today is Wednesday, 2026-11-11.')
    expect(user).toContain('<projects>\nBoard_Prep\n</projects>')
    expect(user).toContain('<ramble>\ndo it ‹/ramble› now\n</ramble>')
  })
})

describe('Ramble', () => {
  it('proposes one task per sentence with the fake model', async () => {
    const { r, llm } = ramble(
      'Call Sam tomorrow. Send the deck p2; book flights also renew the passport',
    )
    const result = await r.ramble(ALICE, {
      audio: new Uint8Array(1),
      mimeType: 'audio/webm',
      tz: 'UTC',
    })
    expect(result.tasks.map((t) => [t.title, t.due, t.priority])).toEqual([
      ['Call Sam', '2026-11-12', undefined],
      ['Send the deck', undefined, 2],
      ['book flights', undefined, undefined],
      ['renew the passport', undefined, undefined],
    ])
    expect(llm.calls[0]?.model).toBe('claude-haiku-5-5')
  })

  it('falls back to the transcript as one task when the model fails or answers oddly', async () => {
    const failing = new FakeLLM(() => {
      throw new Error('overloaded')
    })
    const a = await ramble('Pay rent friday', failing).r.ramble(ALICE, {
      audio: new Uint8Array(1),
      mimeType: 'audio/webm',
      tz: 'UTC',
    })
    expect(a.tasks.map((t) => [t.title, t.due])).toEqual([['Pay rent', '2026-11-13']])
    const odd = await ramble('Pay rent', new FakeLLM(() => 'I can help with that!')).r.ramble(
      ALICE,
      { audio: new Uint8Array(1), mimeType: 'audio/webm', tz: 'UTC' },
    )
    expect(odd.tasks.map((t) => t.title)).toEqual(['Pay rent'])
    // A long ramble falls back to one line per sentence, none over 200 characters.
    const long = `${'word '.repeat(100)}end. Call Sam`
    const split = await ramble(long, failing).r.ramble(ALICE, {
      audio: new Uint8Array(1),
      mimeType: 'audio/webm',
      tz: 'UTC',
    })
    expect(split.tasks).toHaveLength(2)
    expect(split.tasks[0]?.title.length).toBeLessThanOrEqual(200)
    expect(split.tasks[1]?.title).toBe('Call Sam')
  })

  it('skips the model for silence, and refuses an unknown zone', async () => {
    const { r, llm } = ramble('  ')
    expect(
      await r.ramble(ALICE, { audio: new Uint8Array(1), mimeType: 'audio/webm', tz: 'UTC' }),
    ).toEqual({ transcript: '', tasks: [] })
    expect(llm.calls).toEqual([])
    await expect(
      r.ramble(ALICE, { audio: new Uint8Array(1), mimeType: 'audio/webm', tz: 'Nowhere/Land' }),
    ).rejects.toMatchObject({ code: 'bad_request' })
  })
})

describe('members in Ramble', () => {
  const people = [{ email: 'priya@example.test', name: 'Priya Natarajan', handle: 'priya' }]

  it('lists the members the model may assign', () => {
    const { system, user } = buildRamblePrompt({
      transcript: 'x',
      today: '2026-11-11',
      projects: [],
      people,
    })
    expect(user).toContain('<people>\n+priya Priya Natarajan\n</people>')
    expect(system).toContain('only someone listed in <people>')
  })

  it('drops an assignee who is not a member, so the task can still be added', () => {
    const [sam, priya] =
      parseRambleResponse(
        '<tasks>\nCall Sam +sam tomorrow\nSend the deck +priya\n</tasks>',
        '2026-11-11',
      ) ?? []
    const kept = knownAssignee(sam!, people)
    expect(kept.assignee).toBeUndefined()
    expect(kept.title).toBe('Call Sam (for sam)')
    expect(kept.due).toBe('2026-11-12')
    expect(kept.tokens.some((t) => t.kind === 'assignee')).toBe(false)
    expect(knownAssignee(priya!, people).assignee).toBe('priya')
  })
})
