import { docUrl, expect, signIn, test, uid } from './fixtures'

// For you (docs/PLAN-comments.md ★R13, R12, R14, R15): a teammate @mentions me, the rail's For you
// entry (pinned by default) counts it, the list shows it, opening it lands on the comment and lowers
// the count, and Done takes it off.

test('a mention lands in For you, opening it clears the count, Done takes it off', async ({
  page,
  api,
  user,
  browser,
}) => {
  const id = uid()
  const file = `e2e/for-you-${id}.md`
  await api.writeFile(user.team, file, `# For you ${id}\n\nWho owns the budget?\n`)

  // A fresh member: For you is on the rail, right under Today.
  const mate = `e2e-foryou-${id}@example.test`
  const context = await browser.newContext()
  const theirs = await context.newPage()
  await signIn(theirs, mate)
  await theirs.goto('/today')
  const rail = theirs.getByTestId('app-rail')
  const entries = rail.locator('[data-testid^="app-switch-"]')
  await expect(entries.nth(0)).toHaveAttribute('data-testid', 'app-switch-today')
  await expect(entries.nth(1)).toHaveAttribute('data-testid', 'app-switch-for-you')
  const entry = rail.getByTestId('app-switch-for-you')
  await expect(entry.getByTestId('rail-count')).toHaveCount(0)
  const res = await theirs.request.get('/api/me', { headers: { 'x-hearth-dev-user': mate } })
  const me = (await res.json()) as { principal: { name: string; handle: string } }

  // I mention them under the doc, picking them from the list.
  await page.goto(docUrl(user.team, file))
  const box = page.getByTestId('comment-input')
  await box.click()
  await box.pressSequentially(`@${me.principal.handle}`)
  await page.getByTestId('mention-option').filter({ hasText: me.principal.name }).click()
  await box.pressSequentially(`can you own this? ${id}`)
  await page.getByTestId('comment-send').click()
  await expect(page.getByTestId('comment').filter({ hasText: id })).toBeVisible()

  // Their rail counts it without a reload, and Today's tile lists it.
  await expect(entry.getByTestId('rail-count')).toHaveText('1')
  await expect(theirs.getByTestId('today-for-you').getByTestId('for-you-item')).toContainText(
    `For you ${id}`,
  )

  // The list shows it; opening it lands on the comment and lowers the count, and it stays listed.
  await entry.click()
  const row = theirs.getByTestId('for-you-item').filter({ hasText: `For you ${id}` })
  await expect(row).toContainText('mentioned you')
  await row.getByTestId('for-you-open').click()
  await expect(theirs).toHaveURL(new RegExp(`${file.replace('.', '\\.')}#comment-`))
  await expect(theirs.getByTestId('comment').filter({ hasText: id })).toBeVisible()
  await expect(entry.getByTestId('rail-count')).toHaveCount(0)
  await entry.click()
  await expect(row).toBeVisible()
  await expect(row).not.toHaveAttribute('data-unseen', 'true')

  // Done takes it off; Undo brings it back; Done again.
  await row.getByTestId('for-you-done').click()
  await expect(row).toHaveCount(0)
  await theirs.getByTestId('for-you-undo').click()
  await expect(row).toBeVisible()
  await row.getByTestId('for-you-done').click()
  await expect(row).toHaveCount(0)
  await theirs.reload()
  await expect(theirs.getByTestId('for-you-item').filter({ hasText: `For you ${id}` })).toHaveCount(
    0,
  )
  await context.close()
})
