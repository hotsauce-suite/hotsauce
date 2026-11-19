import { uid } from './fixtures'
import { expect, test } from './meetings-fixtures'

// Send feedback (docs/plans/2026-11-12-feedback.md): a vague report gets a question first, then
// it is filed and shows in "Your feedback"; when the team asks a question, the member answers it.

test('a member sends a bug, answers the follow-up, and answers the team later', async ({
  page,
  member,
}) => {
  const id = uid()
  await page.goto('/docs')
  await page.getByTestId('account-menu').click()
  await page.getByTestId('menu-feedback').click()
  await expect(page).toHaveURL(/\/feedback\?from=%2Fdocs/)

  await page.getByTestId('feedback-kind-bug').check({ force: true })
  // Short, so the clarify step asks first.
  await page.getByTestId('feedback-text').fill(`Search broke ${id}`)
  await page.getByTestId('feedback-send').click()
  const questions = page.getByTestId('feedback-questions')
  await expect(questions).toContainText('What were you doing when it happened?')
  await page.getByTestId('feedback-answer').fill('Searching Docs for budget')
  await page.getByTestId('feedback-answer-send').click()
  await expect(page.getByTestId('feedback-sent')).toBeVisible()

  const item = page.getByTestId('feedback-item').filter({ hasText: `Search broke ${id}` })
  await expect(item.getByTestId('feedback-status')).toHaveText('Received')

  // The team asks a question.
  const number = await item.getAttribute('data-number')
  const asked = await member.request.post(`/api/test/feedback/${number}/ask`, {
    data: { question: 'Which space were you in?' },
  })
  expect(asked.ok()).toBe(true)
  await page.reload()
  await expect(item.getByTestId('feedback-status')).toHaveText('We have a question')
  await expect(item.getByTestId('feedback-question')).toHaveText('Which space were you in?')
  await item.getByTestId('feedback-reply').fill('The team space')
  await item.getByTestId('feedback-reply-send').click()
  await expect(item.getByTestId('feedback-status')).toHaveText('Received')
})

test('the account menu opens Send feedback too', async ({ page, member }) => {
  expect(member.email).toBeTruthy()
  await page.goto('/tasks')
  await page.getByTestId('account-menu').click()
  await page.getByTestId('menu-feedback').click()
  await expect(page).toHaveURL(/\/feedback\?from=%2Ftasks/)
  await expect(page.getByTestId('feedback-form')).toBeVisible()
})

// docs/PLAN-feedback-screenshots.md S11: the page picture and one of their own go with the item.
test('a member attaches the page picture and a screenshot of their own', async ({
  page,
  member,
}) => {
  const id = uid()
  await page.goto('/docs')
  await page.getByTestId('account-menu').click()
  await page.getByTestId('menu-feedback').click()
  await expect(page).toHaveURL(/\/feedback\?from=%2Fdocs/)

  // The picture of Docs is offered, not attached, until it's tapped.
  const offer = page.getByTestId('feedback-page-shot')
  await expect(offer).toBeVisible()
  await expect(page.getByTestId('feedback-shot')).toHaveCount(0)
  await offer.getByRole('button', { name: 'Add a picture of the page you were on' }).click()
  await expect(page.getByTestId('feedback-shot')).toHaveCount(1)

  const own = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 2400
    canvas.height = 1200
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no canvas')
    ctx.fillStyle = '#d4552b'
    ctx.fillRect(0, 0, 2400, 1200)
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
    return Array.from(new Uint8Array(await (blob as Blob).arrayBuffer()))
  })
  await page.getByTestId('feedback-shot-input').setInputFiles({
    name: 'wide.png',
    mimeType: 'image/png',
    buffer: Buffer.from(own),
  })
  await expect(page.getByTestId('feedback-shot')).toHaveCount(2)

  await page.getByTestId('feedback-kind-idea').check({ force: true })
  await page
    .getByTestId('feedback-text')
    .fill(`Docs could show who is editing a page right now, next to its title ${id}`)
  await page.getByTestId('feedback-send').click()
  await expect(page.getByTestId('feedback-sent')).toBeVisible()

  const item = page.getByTestId('feedback-item').filter({ hasText: id })
  const number = await item.getAttribute('data-number')
  const filed = await (await member.request.get(`/api/test/feedback/${number}`)).json()
  expect(filed.uploads).toHaveLength(2)
  expect(filed.body).toContain('![Screenshot 1](')
  expect(filed.body).toContain('![Screenshot 2](')
})
