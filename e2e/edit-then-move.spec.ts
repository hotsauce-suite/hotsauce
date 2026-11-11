import {
  docText,
  docUrl,
  expandTreeTo,
  expect,
  isDocUrl,
  test,
  treeItem,
  typeAtEnd,
  uid,
} from './fixtures'

// AUDIT-2026-11 D2: edits typed just before a rename or delete (inside the idle-commit window)
// travel with the doc, and the old path never comes back.

test('renaming a doc right after typing keeps the typing and leaves no old file', async ({
  page,
  api,
  user,
}) => {
  const id = uid()
  const file = `docs/e2e-edit-move-${id}.md`
  const renamed = `docs/e2e-edit-moved-${id}.md`
  await api.writeFile(user.team, file, `# Edit then move ${id}\n\nFirst line.\n`)

  await page.goto(docUrl(user.team, file))
  await expect(docText(page)).toContainText(`Edit then move ${id}`)
  await page.getByTestId('editor-content').click()
  const typed = `Typed just before the rename ${id}`
  await typeAtEnd(page, typed)

  await expandTreeTo(page, file)
  await treeItem(page, file).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  const input = page.getByLabel(`Rename e2e-edit-move-${id}.md`)
  await input.fill(`e2e-edit-moved-${id}`)
  await input.press('Enter')

  await expect(page).toHaveURL(isDocUrl(user.team, renamed))
  await expect.poll(async () => (await api.readFile(user.team, renamed))?.content).toContain(typed)
  // Give any leave-the-page save time to land, then check the old path stayed gone.
  await page.waitForTimeout(1_000)
  expect(await api.readFile(user.team, file)).toBeNull()
})

test('deleting a doc right after typing sends it to the trash and it stays there', async ({
  page,
  api,
  user,
}) => {
  const id = uid()
  const file = `docs/e2e-edit-delete-${id}.md`
  await api.writeFile(user.team, file, `# Edit then delete ${id}\n\nFirst line.\n`)

  await page.goto(docUrl(user.team, file))
  await expect(docText(page)).toContainText(`Edit then delete ${id}`)
  await page.getByTestId('editor-content').click()
  await typeAtEnd(page, `Typed just before the delete ${id}`)

  await expandTreeTo(page, file)
  await treeItem(page, file).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Move to trash' }).click()

  await expect(page).not.toHaveURL(isDocUrl(user.team, file))
  await page.waitForTimeout(1_000)
  expect(await api.readFile(user.team, file)).toBeNull()
})
