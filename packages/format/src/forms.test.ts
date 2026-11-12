import { describe, expect, it } from 'vitest'
import {
  answersCsv,
  answerText,
  checkAnswers,
  FormFrontmatter,
  formPathParts,
  newQuestionId,
  Question,
  questionsProblem,
  visibleQuestions,
} from './forms.js'

// Hearth Forms (docs/plans/2026-11-12-forms.md R1–R4).

const ID = '01JD0000000000000000000000'
const ID2 = '01JD0000000000000000000001'
const q = (over: Partial<Question> & Pick<Question, 'id' | 'type'>): Question =>
  Question.parse({ label: over.id, ...over })

const QUESTIONS: Question[] = [
  q({ id: 'name', type: 'short', required: true }),
  q({ id: 'role', type: 'choice', options: ['Lab', 'Office'], required: true }),
  q({
    id: 'kit',
    type: 'multi',
    options: ['Gloves', 'Goggles'],
    show_if: { question: 'role', is: 'Lab' },
  }),
  q({ id: 'why', type: 'long', required: true, show_if: { question: 'kit', is: 'Goggles' } }),
  q({ id: 'stars', type: 'rating', scale: 10 }),
  q({ id: 'when', type: 'date' }),
  q({ id: 'mail', type: 'email' }),
  q({ id: 'cv', type: 'file' }),
]

describe('form files (R1)', () => {
  it('parses a form with defaults and keeps unknown keys', () => {
    const fm = FormFrontmatter.parse({
      id: ID,
      type: 'form',
      title: 'Intake',
      link: 'x'.repeat(24),
      extra: 1,
    })
    expect(fm).toMatchObject({
      access: 'team',
      open: true,
      room: null,
      questions: [],
      description: '',
      extra: 1,
    })
  })

  it('knows form and answer paths', () => {
    expect(formPathParts(`forms/${ID}.md`)).toEqual({ formId: ID, answerId: null })
    expect(formPathParts(`forms/${ID}/${ID2}.md`)).toEqual({ formId: ID, answerId: ID2 })
    expect(formPathParts('forms/notes.md')).toBeNull()
    expect(formPathParts(`docs/${ID}.md`)).toBeNull()
  })
})

describe('questions (R2, R3)', () => {
  it('accepts a good set and rejects bad options and show-ifs', () => {
    expect(questionsProblem(QUESTIONS)).toBeNull()
    expect(questionsProblem([q({ id: 'a', type: 'choice', options: [] })])).toMatch(
      /at least one option/,
    )
    expect(questionsProblem([q({ id: 'a', type: 'choice', options: ['x', 'X'] })])).toMatch(/twice/)
    expect(questionsProblem([q({ id: 'a', type: 'short', options: ['x'] })])).toMatch(
      /can't have options/,
    )
    expect(questionsProblem([q({ id: 'a', type: 'short' }), q({ id: 'a', type: 'long' })])).toMatch(
      /same id/,
    )
    expect(
      questionsProblem([
        q({ id: 'b', type: 'short', show_if: { question: 'a', is: 'x' } }),
        q({ id: 'a', type: 'choice', options: ['x'] }),
      ]),
    ).toMatch(/isn't before it/)
    expect(
      questionsProblem([
        q({ id: 'a', type: 'short' }),
        q({ id: 'b', type: 'short', show_if: { question: 'a', is: 'x' } }),
      ]),
    ).toMatch(/without options/)
    expect(
      questionsProblem([
        q({ id: 'a', type: 'choice', options: ['x'] }),
        q({ id: 'b', type: 'short', show_if: { question: 'a', is: 'y' } }),
      ]),
    ).toMatch(/option that question doesn't have/)
  })

  it('shows a question only when its condition holds, following chains', () => {
    const ids = (a: Record<string, unknown>) =>
      visibleQuestions(QUESTIONS, a as never).map((x) => x.id)
    expect(ids({})).toEqual(['name', 'role', 'stars', 'when', 'mail', 'cv'])
    expect(ids({ role: 'Lab' })).toContain('kit')
    expect(ids({ role: 'Lab', kit: ['Goggles'] })).toContain('why')
    // The chain breaks when the middle question is hidden, even with a stale answer.
    expect(ids({ role: 'Office', kit: ['Goggles'] })).not.toContain('why')
  })
})

describe('checking answers (R4)', () => {
  it('passes a good answer, trims text and drops hidden answers', () => {
    const r = checkAnswers(QUESTIONS, {
      name: '  Ada ',
      role: 'Office',
      kit: ['Gloves'],
      stars: 9,
      when: '2026-02-28',
    })
    expect(r).toEqual({
      ok: true,
      answers: { name: 'Ada', role: 'Office', stars: 9, when: '2026-02-28' },
    })
  })

  it('requires shown required questions only', () => {
    const r = checkAnswers(QUESTIONS, { role: 'Lab', kit: ['Goggles'] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['name', 'why'])
    expect(checkAnswers(QUESTIONS, { name: 'A', role: 'Lab' }).ok).toBe(true)
  })

  it('refuses values that do not fit the question', () => {
    const errs = (a: Record<string, unknown>) => {
      const r = checkAnswers(QUESTIONS, { name: 'A', role: 'Lab', ...a })
      return r.ok ? {} : r.errors
    }
    expect(errs({ role: 'Remote' })).toHaveProperty('role')
    expect(errs({ kit: ['Gloves', 'Gloves'] })).toHaveProperty('kit')
    expect(errs({ kit: ['Hat'] })).toHaveProperty('kit')
    expect(errs({ stars: 11 })).toHaveProperty('stars')
    expect(errs({ stars: 2.5 })).toHaveProperty('stars')
    expect(errs({ when: '2026-02-30' })).toHaveProperty('when')
    expect(errs({ mail: 'not an email' })).toHaveProperty('mail')
    expect(errs({ name: 'x'.repeat(501) })).toHaveProperty('name')
    expect(errs({ cv: [{ id: ID, name: 'a.pdf', size: 11 * 1024 * 1024 }] })).toHaveProperty('cv')
    expect(errs({ cv: 'a.pdf' })).toHaveProperty('cv')
    const four = Array.from({ length: 4 }, (_, i) => ({ id: ID, name: `${i}.pdf`, size: 10 }))
    expect(errs({ cv: four })).toHaveProperty('cv')
    expect(errs({ cv: four.slice(0, 3) })).toEqual({})
  })
})

describe('answer text and CSV (R9, R11)', () => {
  it('writes answers as text in form order', () => {
    expect(
      answerText(QUESTIONS, {
        role: 'Lab',
        name: 'Ada',
        cv: [{ id: ID, name: 'cv.pdf', size: 1 }],
      }),
    ).toBe('**name**\nAda\n\n**role**\nLab\n\n**cv**\ncv.pdf')
  })

  it('exports CSV with quoting and formula guards', () => {
    const csv = answersCsv(QUESTIONS.slice(0, 3), [
      {
        submitted: '2026-11-12T10:00:00Z',
        submittedBy: null,
        answers: { name: '=SUM(A1)', role: 'Lab', kit: ['Gloves', 'Goggles'] },
      },
      {
        submitted: '2026-11-12T11:00:00Z',
        submittedBy: 'a@b.c',
        answers: { name: 'Said "hi"\nthen left' },
      },
    ])
    expect(csv).toBe(
      'Submitted,From,name,role,kit\r\n' +
        '2026-11-12T10:00:00Z,,\'=SUM(A1),Lab,"Gloves, Goggles"\r\n' +
        '2026-11-12T11:00:00Z,a@b.c,"Said ""hi""\nthen left",,\r\n',
    )
  })

  it('makes question ids that are new', () => {
    let n = 0
    const rnd = () => [0, 0, 0.5][n++] ?? 0.5
    const first = newQuestionId([], () => 0)
    expect(first).toBe('q000000')
    expect(newQuestionId([first], rnd)).not.toBe(first)
  })
})
