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
  await page.getByTestId('feedback-link').click()
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
