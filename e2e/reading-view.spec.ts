import { docUrl, expect, test, uid } from './fixtures'

test('the reading view renders headings, a table, and task checkboxes', async ({
  page,
  api,
  user,
}) => {
  const id = uid()
  const file = `docs/e2e-reading-${id}.md`
  await api.writeFile(
    user.team,
    file,
    [
      `# Reading ${id}`,
      '',
      '## Stock levels',
      '',
      '| Clay | Bags |',
      '| ---- | ---: |',
      '| Stoneware | 12 |',
      '| Porcelain | 4 |',
      '',
      '### Before Friday',
      '',
      '- [ ] Order porcelain',
      '- [x] Count the stoneware',
      '',
    ].join('\n'),
  )

  await page.goto(docUrl(user.team, file))
  await expect(page.getByTestId('editor-content')).toContainText('Stock levels')
  await page.getByTestId('reading-toggle').click()

  const view = page.getByTestId('reading-view')
  await expect(view).toBeVisible()
  await expect(view.getByRole('heading', { level: 2, name: 'Stock levels' })).toBeVisible()
  await expect(view.getByRole('heading', { level: 3, name: 'Before Friday' })).toBeVisible()

  const table = view.getByRole('table')
  await expect(table.getByRole('columnheader', { name: 'Clay' })).toBeVisible()
  await expect(table.getByRole('row')).toHaveCount(3)
  await expect(table.getByRole('cell', { name: 'Porcelain' })).toBeVisible()

  const boxes = view.getByRole('checkbox')
  await expect(boxes).toHaveCount(2)
  await expect(boxes.nth(0)).not.toBeChecked()
  await expect(boxes.nth(1)).toBeChecked()

  // Toggling again returns to the editor.
  await page.getByTestId('reading-toggle').click()
  await expect(page.getByTestId('editor-content')).toBeVisible()
  await expect(view).toBeHidden()
})
