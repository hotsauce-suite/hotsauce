import { docUrl, expect, isDocUrl, replaceLine, test, uid } from './fixtures'

// Docs PRD §5: the slug comes from the title at creation; renaming the title offers to rename
// the file.

test('retitling a doc offers to rename its file, and the doc follows the rename', async ({
  page,
  api,
  user,
}) => {
  const id = uid()
  const file = `docs/e2e-retitle-${id}.md`
  const renamed = `docs/kiln-log-${id}.md`
  await api.writeFile(user.team, file, `# Retitle ${id}\n\nThe body stays.\n`)

  await page.goto(docUrl(user.team, file))
  await expect(page.getByTestId('editor-content')).toContainText('The body stays.')

  await replaceLine(page, `Retitle ${id}`, `# Kiln log ${id}`)
  const offer = page.getByTestId('rename-to-title')
  await expect(offer).toHaveText(`Rename file to kiln-log-${id}.md`)
  await offer.click()

  await expect(page).toHaveURL(isDocUrl(user.team, renamed))
  await expect(page.getByTestId('editor-content')).toContainText(`Kiln log ${id}`)
  expect(await api.readFile(user.team, file)).toBeNull()
  expect((await api.readFile(user.team, renamed))?.content).toContain(
    `# Kiln log ${id}\n\nThe body stays.\n`,
  )
  // The edit was committed before the move, and history follows the file across it.
  const commits = await api.history(user.team, renamed)
  expect(commits.map((c) => c.message)).toEqual([
    `hearth: move "${file}" to "${renamed}"`,
    `docs: edit "Kiln log ${id}"`,
    `docs: create "Retitle ${id}"`,
  ])
})
