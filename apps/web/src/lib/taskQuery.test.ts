import { describe, expect, it } from 'vitest'
import type { TaskView } from '../api/tasks'
import { applyTaskQuery, DEFAULT_LIMIT, parseTaskQuery } from './taskQuery'

// 2026-11-12 is a Thursday.
const NOW = new Date('2026-11-12T15:00:00Z')
const parse = (text: string) => parseTaskQuery(text, 'America/New_York', NOW)

describe('task queries', () => {
  it('an empty block is the open tasks the member can see', () => {
    expect(parse('')).toEqual({
      filter: { status: 'open', limit: DEFAULT_LIMIT },
      label: null,
      limit: DEFAULT_LIMIT,
      problems: [],
    })
  })

  it('reads every key, ignoring case, blank lines and comments', () => {
    const q = parse(
      '# Ops this week\nStatus: all\nmine: yes\n\nproject: Ops\nspace: team\nsearch: deck\nlimit: 5\n',
    )
    expect(q.filter).toEqual({
      status: 'all',
      mine: true,
      project: 'Ops',
      space: 'team',
      q: 'deck',
      limit: 5,
    })
    expect(q.problems).toEqual([])
  })

  it('reads due ranges in the member’s own day', () => {
    expect(parse('due: today').filter.dueBefore).toBe('2026-11-12')
    expect(parse('due: overdue').filter.dueBefore).toBe('2026-11-11')
    expect(parse('due: this week').filter.dueBefore).toBe('2026-11-18')
    expect(parse('due: before 2026-12-01').filter.dueBefore).toBe('2026-11-30')
    expect(parse('due: after 2026-12-01').filter.dueAfter).toBe('2026-12-02')
  })

  it('project none is the Inbox; a label asks the server for more, to filter here', () => {
    expect(parse('project: none').filter.project).toBe('')
    const q = parse('label: @errand\nlimit: 3')
    expect(q.label).toBe('errand')
    expect(q.filter.limit).toBe(500)
    expect(q.limit).toBe(3)
  })

  it('says what it didn’t understand and runs the rest', () => {
    const q = parse('status: maybe\ncolour: red\nOps\ndue: soon\nlimit: 0\nmine: yes')
    expect(q.filter).toEqual({ status: 'open', mine: true, limit: DEFAULT_LIMIT })
    expect(q.problems).toHaveLength(5)
    expect(q.problems[0]).toContain('open, done or all')
    expect(q.problems[1]).toContain('“colour” isn’t a task query key')
  })

  it('applies the label and the limit to what came back', () => {
    const task = (id: string, labels: string[]) => ({ id, labels }) as unknown as TaskView
    const tasks = [
      task('a', ['Errand']),
      task('b', []),
      task('c', ['errand']),
      task('d', ['errand']),
    ]
    expect(applyTaskQuery(parse('label: errand\nlimit: 2'), tasks).map((t) => t.id)).toEqual([
      'a',
      'c',
    ])
    expect(applyTaskQuery(parse('limit: 1'), tasks).map((t) => t.id)).toEqual(['a'])
  })
})
