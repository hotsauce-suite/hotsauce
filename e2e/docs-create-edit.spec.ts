import { expect, parseDocUrl, test, typeAtEnd, uid, waitForSave } from './fixtures'

test('a new doc commits on idle with the signed-in user as author', async ({
  page,
  api,
  user,
  waitForState,
}) => {
  const text = `First words ${uid()}`

  await page.goto('/docs')
  await page.getByTestId('new-doc').click()
  await expect(page).toHaveURL((url) => /^\/docs\/[^/]+\/.+\.md$/.test(url.pathname))
  const doc = parseDocUrl(page.url())

  const editor = page.getByTestId('editor-content')
  await expect(editor).toBeVisible()
  await editor.click()
  const saved = waitForSave(page, text)
  await typeAtEnd(page, text)
  expect((await saved).ok()).toBe(true)
  await waitForState('save-state', 'committed', { timeout: 3_000 })

  // One commit in Git, authored by the user (Hearth is only the committer).
  expect((await api.readFile(doc.space, doc.path))?.content).toContain(text)
  const commits = await api.history(doc.space, doc.path)
  expect(commits.map((c) => c.author)).toEqual([{ name: user.name, email: user.email }])

  await page.getByTestId('history-toggle').click()
  const items = page.getByTestId('history-item')
  await expect(items).toHaveCount(1)
  await expect(items.first()).toContainText(user.name)
  const oids = await items.evaluateAll((els) => els.map((el) => el.getAttribute('data-oid')))
  expect(oids).toEqual(commits.map((c) => c.oid))
})
