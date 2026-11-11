import { docText, docUrl, expandTreeTo, expect, isDocUrl, test, treeItem, uid } from './fixtures'

test('sharing a personal doc moves it to the team space', async ({ page, api, user }) => {
  const id = uid()
  const doc = `docs/e2e-share-${id}.md`
  const neighbour = `docs/e2e-stays-${id}.md`
  await api.writeFile(user.personal, doc, `# Share me ${id}\n\nReady for the team.\n`)
  await api.writeFile(user.personal, neighbour, `# Stays personal ${id}\n`)

  await page.goto(docUrl(user.personal, doc))
  await expect(docText(page)).toContainText(`Share me ${id}`)

  await page.getByTestId('share-menu').click()
  await page.getByTestId('share-to-team').click()
  // Docs PRD §4.6: a target-folder picker, defaulting to the team's docs/ root.
  const shared = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().includes('/share-to-team'),
  )
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /^share/i })
    .click()
  const response = await shared
  expect(response.ok()).toBe(true)
  const { teamPath } = (await response.json()) as { teamPath: string }

  // It opens in the team space and shows in the team tree.
  await expect(page).toHaveURL(isDocUrl(user.team, teamPath))
  await expect(docText(page)).toContainText(`Share me ${id}`)
  await expandTreeTo(page, teamPath)
  await expect(treeItem(page, teamPath)).toBeVisible()

  // It is gone from the personal space, in Git and in the tree.
  expect(await api.readFile(user.personal, doc)).toBeNull()
  await page.goto(docUrl(user.personal, neighbour))
  await expandTreeTo(page, neighbour)
  await expect(treeItem(page, neighbour)).toBeVisible()
  await expect(treeItem(page, doc)).toHaveCount(0)
})
