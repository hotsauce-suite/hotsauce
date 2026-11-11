import { docUrl, expandTreeTo, expect, test, treeItem, uid } from './fixtures'

// Pushes straight to the bare remote stand in for Obsidian, VS Code, or an agent.
// With POLL_INTERVAL_MS=1000 the server should pick them up well inside 3 s.

test('a file pushed from outside appears in the tree', async ({ page, api, user, remote }) => {
  const folder = `docs/e2e-outside-${uid()}`
  const seed = `${folder}/seed.md`
  const pushed = `${folder}/from-outside.md`
  await api.writeFile(user.team, seed, '# Seed\n\nKeeps the folder in the tree.\n')

  await page.goto(docUrl(user.team, seed))
  await expandTreeTo(page, seed)
  await expect(treeItem(page, seed)).toBeVisible()

  const checkout = await remote.clone('team')
  await checkout.write(pushed, '# From outside\n\nWritten in another editor.\n')
  await checkout.commitAndPush('Add a doc from outside Hearth')

  await expect(treeItem(page, pushed)).toBeVisible({ timeout: 3_000 })
})

test('an open doc with no local edits refreshes after an outside push', async ({
  page,
  api,
  user,
  remote,
  waitForState,
}) => {
  const id = uid()
  const file = `docs/e2e-refresh-${id}.md`
  await api.writeFile(user.team, file, '# Refresh me\n\nThe original sentence.\n')

  await page.goto(docUrl(user.team, file))
  const editor = page.getByTestId('editor-content')
  await expect(editor).toContainText('The original sentence.')
  await waitForState('save-state', 'committed')

  const checkout = await remote.clone('team')
  await checkout.edit(file, (text) =>
    text.replace('The original sentence.', `Rewritten outside ${id}.`),
  )
  await checkout.commitAndPush('Edit from outside Hearth')

  await expect(editor).toContainText(`Rewritten outside ${id}.`, { timeout: 3_000 })
  await expect(editor).not.toContainText('The original sentence.')
  // Adopting the pushed version is not a local edit; there is nothing to save.
  await waitForState('save-state', 'committed')
})
