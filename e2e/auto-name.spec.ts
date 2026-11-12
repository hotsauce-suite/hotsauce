import { docUrl, expect, isDocUrl, parseDocUrl, replaceLine, test, uid } from './fixtures'

// A new doc takes its file name from its first heading on its own, once the cursor has moved on.

test('a new doc takes its heading’s name, and the cursor stays put', async ({ page, api }) => {
  const id = uid()
  await page.goto('/docs')
  await page.getByTestId('new-doc').click()
  await expect(page).toHaveURL((url) => /untitled(-\d+)?\.md$/.test(url.pathname))
  const { space } = parseDocUrl(page.url())

  const editor = page.getByTestId('editor-content')
  await expect(editor).toBeVisible()
  // "Untitled" starts selected, so typing replaces it.
  await page.keyboard.type(`Kiln plan ${id}`)
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('First line.')

  const named = `docs/kiln-plan-${id}.md`
  await expect(page).toHaveURL(isDocUrl(space, named))
  // No offer to answer: the name was taken automatically.
  await expect(page.getByTestId('rename-to-title')).toHaveCount(0)
  // Typing carries on where it was.
  await expect(editor).toBeFocused()
  await page.keyboard.type(' Second.')
  await expect(editor).toContainText('First line. Second.')
  await expect
    .poll(async () => (await api.readFile(space, named))?.content ?? '')
    .toContain(`# Kiln plan ${id}`)
  // Created under its name: untitled.md never entered Git.
  const history = await api.history(space, named)
  expect(history.map((c) => c.message)).toEqual([`docs: create "Kiln plan ${id}"`])
})

test('a new doc left right after its heading is typed still takes the name', async ({
  page,
  api,
}) => {
  const id = uid()
  await page.goto('/docs')
  await page.getByTestId('new-doc').click()
  await expect(page).toHaveURL((url) => /untitled(-\d+)?\.md$/.test(url.pathname))
  const { space } = parseDocUrl(page.url())
  await expect(page.getByTestId('editor-content')).toBeVisible()
  await page.keyboard.type(`Quick note ${id}`)

  await page.getByTestId('settings-link').first().click()
  await expect(page).toHaveURL(/\/settings$/)
  await expect
    .poll(async () => (await api.readFile(space, `docs/quick-note-${id}.md`))?.content ?? '')
    .toContain(`# Quick note ${id}`)
  expect((await api.history(space, `docs/quick-note-${id}.md`)).map((c) => c.message)).toEqual([
    `docs: create "Quick note ${id}"`,
  ])
})

test('a doc with a real name is only offered the rename', async ({ page, api, user }) => {
  const id = uid()
  const file = `docs/e2e-named-${id}.md`
  await api.writeFile(user.team, file, `# Named ${id}\n\nBody.\n`)
  await page.goto(docUrl(user.team, file))
  await expect(page.getByTestId('editor-content')).toContainText('Body.')
  await replaceLine(page, `Named ${id}`, `# Named ${id} two`)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(page.getByTestId('rename-to-title')).toBeVisible()
  await page.waitForTimeout(2_000)
  await expect(page).toHaveURL(isDocUrl(user.team, file))
})
