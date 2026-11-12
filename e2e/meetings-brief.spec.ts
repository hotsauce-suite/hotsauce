import { uid } from './fixtures'
import { expect, test } from './meetings-fixtures'

test('the agent brief is written from your meetings and follows your corrections', async ({
  page,
  member,
}) => {
  const id = uid()
  const title = `Northwind pricing ${id}`
  const date = new Date(Date.now() - 86_400_000).toISOString()
  await member.api.writeFile(
    member.personal,
    `meetings/2026/11/northwind-${id}.md`,
    `---\ntype: meeting\ntitle: ${title}\ndate: ${date}\nattendees: []\n---\n# ${title}\n\n## Decisions\n\n- Ship tiered pricing\n`,
  )

  await page.goto('/meetings')
  await page.getByRole('link', { name: 'Agent brief' }).click()
  await expect(page).toHaveURL(/\/meetings\/brief$/)

  // The index takes the commit just after it lands; rewrite until the brief has the meeting.
  await expect(async () => {
    await page.getByTestId('brief-rewrite').click()
    await expect(page.getByTestId('brief-body')).toContainText(`Newest meeting: ${title}`, {
      timeout: 2_000,
    })
  }).toPass({ timeout: 20_000 })
  await expect(
    page.getByTestId('brief-body').getByRole('heading', { name: 'What changed' }),
  ).toBeVisible()
  await expect(page.getByTestId('brief-written')).toContainText('Written today')

  await page.getByTestId('brief-notes').fill(`I lead growth ${id}.`)
  await page.getByTestId('brief-notes-rewrite').click()
  await expect(page.getByTestId('brief-body')).toContainText(`Notes: I lead growth ${id}.`)

  // It's a file in the member's own space, so it survives a reload.
  await page.reload()
  await expect(page.getByTestId('brief-body')).toContainText(`Notes: I lead growth ${id}.`)
  await expect(page.getByTestId('brief-notes')).toHaveValue(`I lead growth ${id}.`)
})
