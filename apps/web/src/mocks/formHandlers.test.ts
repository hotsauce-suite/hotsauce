import { isFormId, isId, QUESTION_TYPES } from '@hearth/format'
import { describe, expect, it } from 'vitest'
import { filesApi } from '../api/files'
import { formsApi } from '../api/forms'

const linkOf = (url: string) => url.split('/f/')[1] ?? ''

async function formId(title: string): Promise<string> {
  const { forms } = await formsApi.list()
  return forms.find((f) => f.title === title)?.id ?? ''
}

describe('mock forms', () => {
  it('lists the seeded forms with their answers, using every question type', async () => {
    const { forms, canSummarize } = await formsApi.list()
    expect(canSummarize).toBe(true)
    // Most recently changed first.
    expect(forms.map((f) => [f.title, f.answerCount])).toEqual([
      ['Launch day lunch', 2],
      ['Pilot feedback', 3],
    ])
    const feedback = await formsApi.get('team', await formId('Pilot feedback'))
    expect(new Set(feedback.questions.map((q) => q.type))).toEqual(new Set(QUESTION_TYPES))
  })

  it('keeps seeded ids and fill links the same on every load, so links survive a reload', async () => {
    const { forms } = await formsApi.list()
    for (const f of forms) expect(isFormId(f.id) && isId(f.id)).toBe(true)
    const feedback = await formsApi.get('team', await formId('Pilot feedback'))
    expect(feedback.url).toBe(`${window.location.origin}/f/demo-pilot-feedback`)
  })

  it('creates, edits, closes and deletes a form', async () => {
    const form = await formsApi.create('ada', 'Offsite dates')
    expect(form.questions).toHaveLength(1)
    const saved = await formsApi.save('ada', form.id, {
      title: 'Offsite dates',
      description: 'Pick what works',
      questions: [
        ...form.questions,
        { id: 'q2', type: 'rating', label: 'Excited?', required: false, scale: 10 },
      ],
      access: 'public',
      open: false,
      room: 'pilot',
      blobOid: form.blobOid,
    })
    expect(saved).toMatchObject({ access: 'public', open: false, room: 'pilot' })
    // An edit from the old version is refused.
    await expect(
      formsApi.save('ada', form.id, { ...saved, blobOid: form.blobOid }),
    ).rejects.toMatchObject({ status: 409 })
    await expect(
      formsApi.save('ada', form.id, {
        ...saved,
        questions: [{ id: 'q1', type: 'choice', label: 'Pick', required: false }],
      }),
    ).rejects.toMatchObject({ status: 400 })
    await formsApi.remove('ada', form.id)
    await expect(formsApi.get('ada', form.id)).rejects.toMatchObject({ status: 404 })
  })

  it('takes an answer on the fill page, with a file', async () => {
    const form = await formsApi.get('team', await formId('Pilot feedback'))
    const link = linkOf(form.url)
    const page = await formsApi.fill(link)
    expect(page).toMatchObject({ title: 'Pilot feedback', canTakeAnswers: true, robotCheck: null })

    const bad = await formsApi.submit(link, { answers: {}, token: '', files: [] }).catch((e) => e)
    expect(bad.status).toBe(400)
    expect(Object.keys(bad.details.errors)).toEqual(['name', 'site', 'rating'])

    const shot = new File(['hello'], 'confusing.png', { type: 'image/png' })
    const { id } = await formsApi.submit(link, {
      answers: { name: 'Dana Lee', site: 'Harbor', rating: 4, used: ['Docs'] },
      token: '',
      files: [['shot', shot]],
    })
    const { answers } = await formsApi.answers('team', form.id)
    expect(answers[0]).toMatchObject({ id, submittedBy: 'ada@example.test' })
    const [stored] = (answers[0]?.answers.shot ?? []) as Array<{ id: string; name: string }>
    expect((await filesApi.get('team', stored?.id ?? '')).folder).toBe('Forms/Pilot feedback')
  })

  it('refuses answers once the form is closed', async () => {
    const form = await formsApi.get('team', await formId('Launch day lunch'))
    await formsApi.save('team', form.id, { ...form, open: false })
    const link = linkOf(form.url)
    expect((await formsApi.fill(link)).canTakeAnswers).toBe(false)
    await expect(
      formsApi.submit(link, { answers: { name: 'x', meal: 'Tacos' }, token: '', files: [] }),
    ).rejects.toMatchObject({ status: 409 })
  })

  it('summarizes, exports CSV and deletes an answer', async () => {
    const id = await formId('Pilot feedback')
    const summary = await formsApi.summarize('team', id)
    expect(summary.total).toBe(3)
    expect(summary.tallies.find((t) => t.question === 'rating')?.average).toBe(4)
    expect(summary.tallies.find((t) => t.question === 'site')?.counts).toEqual([
      { option: 'North', count: 1 },
      { option: 'Harbor', count: 1 },
      { option: 'Valley', count: 1 },
    ])
    expect(summary.summary).toContain('3 people')

    const csv = await (await formsApi.csv('team', id)).text()
    const lines = csv.replace(/^﻿/, '').trim().split('\r\n')
    expect(lines[0]).toMatch(/^Submitted,From,Your name,/)
    expect(lines).toHaveLength(4)

    const { answers } = await formsApi.answers('team', id)
    await formsApi.removeAnswer('team', id, answers[0]?.id ?? '')
    expect((await formsApi.answers('team', id)).answers).toHaveLength(2)
  })
})
