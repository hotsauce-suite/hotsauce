import { describe, expect, it } from 'vitest'
import { parseFrontmatter } from './frontmatter.js'
import {
  addMonths,
  dueInstant,
  firstOccurrence,
  localNow,
  newTaskFile,
  nextDue,
  normalizeRecurrence,
  parseQuickAdd,
  TaskFrontmatter,
  taskIdOf,
  taskPath,
} from './tasks.js'

// 2026-11-11 is a Wednesday.
const today = '2026-11-11'
const q = (text: string) => parseQuickAdd(text, { today })

describe('parseQuickAdd', () => {
  it('takes a weekday, a time, a priority, a project, a label and an assignee out of the title', () => {
    const p = q('Call Sam fri 3pm p1 #Ops @calls +alex')
    expect(p).toMatchObject({
      title: 'Call Sam',
      due: '2026-11-13T15:00',
      priority: 1,
      project: 'Ops',
      labels: ['calls'],
      assignee: 'alex',
    })
    expect(p.tokens.map((t) => t.kind)).toEqual([
      'date',
      'time',
      'priority',
      'project',
      'label',
      'assignee',
    ])
  })

  it('leaves plain text alone', () => {
    expect(q('Write the board memo')).toEqual({
      title: 'Write the board memo',
      labels: [],
      tokens: [],
    })
  })

  it.each([
    ['today', '2026-11-11'],
    ['tomorrow', '2026-11-12'],
    ['yesterday', '2026-11-10'],
    ['day after tomorrow', '2026-11-13'],
    ['tmr', '2026-11-12'],
    ['wed', '2026-11-11'],
    ['thursday', '2026-11-12'],
    ['next fri', '2026-11-20'],
    ['next week', '2026-11-16'],
    ['weekend', '2026-11-14'],
    ['in 3 days', '2026-11-14'],
    ['in 2 weeks', '2026-11-25'],
    ['in 1 month', '2026-12-11'],
    ['next month', '2026-12-01'],
    ['nov 20', '2026-11-20'],
    ['20 nov', '2026-11-20'],
    ['November 20th', '2026-11-20'],
    ['jan 5', '2027-01-05'],
    ['11/20', '2026-11-20'],
    ['1/5', '2027-01-05'],
    ['12/1/2027', '2027-12-01'],
    ['2026-12-24', '2026-12-24'],
  ])('reads "%s" as %s', (word, due) => {
    expect(q(`Pay invoice ${word}`)).toMatchObject({ title: 'Pay invoice', due })
  })

  it.each([
    ['3pm', '15:00'],
    ['3:30pm', '15:30'],
    ['at 9am', '09:00'],
    ['12am', '00:00'],
    ['12pm', '12:00'],
    ['15:45', '15:45'],
    ['noon', '12:00'],
  ])('reads the time "%s" as today at %s', (word, time) => {
    expect(q(`Standup ${word}`)).toMatchObject({ title: 'Standup', due: `2026-11-11T${time}` })
  })

  it('reads tonight as 7pm today', () => {
    expect(q('Read the deck tonight').due).toBe('2026-11-11T19:00')
  })

  it('reads recurrence and starts it at the first occurrence', () => {
    expect(q('Water plants every day')).toMatchObject({
      title: 'Water plants',
      recur: 'every day',
      due: '2026-11-11',
    })
    expect(q('Weekly review every friday 4pm')).toMatchObject({
      title: 'Weekly review',
      recur: 'every friday',
      due: '2026-11-13T16:00',
    })
    expect(q('Gym every mon, wed and fri')).toMatchObject({
      title: 'Gym',
      recur: 'every monday, wednesday, friday',
      due: '2026-11-11',
    })
    expect(q('Payroll every 2 weeks')).toMatchObject({ recur: 'every 2 weeks' })
    expect(q('Invoices monthly')).toMatchObject({ title: 'Invoices', recur: 'every month' })
    expect(q('Ship notes every weekday')).toMatchObject({ recur: 'every weekday', due: today })
  })

  it('does not read names or ordinary words as dates', () => {
    expect(q('Email Tom about the lease').due).toBeUndefined()
    expect(q('Fix the today-view bug').title).toBe('Fix the today-view bug')
    expect(q('Order #2 pencils').project).toBe('2')
  })

  it('keeps only the first date and priority; later ones stay in the title', () => {
    const p = q('Move from tomorrow to friday p2 p3')
    expect(p.due).toBe('2026-11-12')
    expect(p.priority).toBe(2)
    expect(p.title).toBe('Move from to friday p3')
  })

  it('takes several labels, lowercased and unique', () => {
    expect(q('Draft @Legal @urgent @legal').labels).toEqual(['legal', 'urgent'])
  })

  it('turns underscores in a project into spaces and accepts an email assignee', () => {
    expect(q('Plan #Board_Meeting +sam@example.test')).toMatchObject({
      project: 'Board Meeting',
      assignee: 'sam@example.test',
    })
  })

  it('drops a dangling "on" or "by" left where the date was', () => {
    expect(q('Send the contract by friday').title).toBe('Send the contract')
    expect(q('Dinner with Kim on nov 20').title).toBe('Dinner with Kim')
  })

  it('reports token positions so the input can highlight them', () => {
    const text = 'Lunch tomorrow p2'
    const p = q(text)
    for (const t of p.tokens) expect(text.slice(t.from, t.to)).toBe(t.text)
  })

  it('ignores impossible dates', () => {
    expect(q('Thing 2/30').due).toBeUndefined()
    expect(q('Thing 2026-02-30').due).toBeUndefined()
  })
})

describe('recurrence', () => {
  it('normalizes rules', () => {
    expect(normalizeRecurrence('Every  Week')).toBe('every week')
    expect(normalizeRecurrence('daily')).toBe('every day')
    expect(normalizeRecurrence('every other week')).toBe('every 2 weeks')
    expect(normalizeRecurrence('every fri, mon')).toBe('every monday, friday')
    expect(normalizeRecurrence('every blue moon')).toBeNull()
    expect(normalizeRecurrence('every 0 days')).toBeNull()
  })

  it('advances to the next occurrence, keeping the time', () => {
    expect(nextDue('every day', '2026-11-11T09:00', today)).toBe('2026-11-12T09:00')
    expect(nextDue('every week', '2026-11-11', today)).toBe('2026-11-18')
    expect(nextDue('every month', '2026-01-31', '2026-01-31')).toBe('2026-02-28')
    expect(nextDue('every weekday', '2026-11-13', '2026-11-13')).toBe('2026-11-16')
    expect(nextDue('every monday, friday', '2026-11-13', '2026-11-13')).toBe('2026-11-16')
    expect(nextDue('every year', '2026-02-28', '2026-02-28')).toBe('2027-02-28')
  })

  it('catches an overdue task up to today', () => {
    expect(nextDue('every day', '2026-11-01', today)).toBe('2026-11-11')
    expect(nextDue('every week', '2026-10-01', today)).toBe('2026-11-12')
  })

  it('returns null for a rule it does not know', () => {
    expect(nextDue('whenever', '2026-11-11', today)).toBeNull()
  })

  it('finds the first occurrence on or after a date', () => {
    expect(firstOccurrence('every weekday', '2026-11-14')).toBe('2026-11-16')
    expect(firstOccurrence('every day', '2026-11-14')).toBe('2026-11-14')
  })

  it('adds months without overflowing', () => {
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28')
    expect(addMonths('2026-11-15', 2)).toBe('2027-01-15')
  })
})

describe('time zones', () => {
  it('resolves a wall time in a zone to an instant, across daylight saving', () => {
    expect(dueInstant('2026-11-11T15:00', 'America/New_York')).toBe('2026-11-11T20:00:00.000Z')
    expect(dueInstant('2026-07-01T15:00', 'America/New_York')).toBe('2026-07-01T19:00:00.000Z')
    expect(dueInstant('2026-11-11T15:00', 'Asia/Kolkata')).toBe('2026-11-11T09:30:00.000Z')
    expect(dueInstant('2026-11-11', 'America/New_York')).toBeNull()
  })

  it('gives the local date and time now', () => {
    expect(localNow(new Date('2026-11-12T03:30:00Z'), 'America/New_York')).toEqual({
      date: '2026-11-11',
      time: '22:30',
    })
  })
})

describe('task files', () => {
  it('writes frontmatter the schema accepts, leaving empty fields out', () => {
    const { id, path, text } = newTaskFile({
      title: '  Call   Sam ',
      notes: 'About the lease',
      priority: 1,
      due: '2026-11-13T15:00',
      tz: 'America/New_York',
      project: 'Ops',
      labels: ['calls'],
      assignee: 'Alex@Example.Test',
      createdBy: 'ada@example.test',
      created: '2026-11-11T12:00:00Z',
    })
    expect(path).toBe(taskPath(id))
    expect(taskIdOf(path)).toBe(id)
    const { data, body } = parseFrontmatter(text)
    const fm = TaskFrontmatter.parse(data)
    expect(fm).toMatchObject({
      type: 'task',
      title: 'Call Sam',
      status: 'open',
      priority: 1,
      due: '2026-11-13T15:00',
      tz: 'America/New_York',
      assignee: 'alex@example.test',
      created_by: 'ada@example.test',
    })
    expect(body.trim()).toBe('About the lease')
    expect(Object.keys(data)).not.toContain('recur')
  })

  it('drops the zone from a date-only task and priority 4', () => {
    const { text } = newTaskFile({
      title: 'x',
      due: '2026-11-13',
      tz: 'UTC',
      priority: 4,
      createdBy: 'a@b.c',
    })
    const { data } = parseFrontmatter(text)
    expect(data.tz).toBeUndefined()
    expect(data.priority).toBeUndefined()
  })

  it('only recognizes tasks/<ulid>.md as a task path', () => {
    expect(taskIdOf('tasks/notes.md')).toBeNull()
    expect(taskIdOf('docs/01JBZ8Q2X3Y4Z5A6B7C8D9E0FG.md')).toBeNull()
  })
})
