import type { Page } from '@playwright/test'
import { expect, isDocUrl, pressCommandK, test, uid } from './fixtures'

/** Opens Cmd-K from the docs shell (outside the editor, where Cmd-K inserts a link). */
async function openCommandK(page: Page): Promise<void> {
  await page.goto('/docs')
  await expect(page.getByTestId('sidebar')).toBeVisible()
  await pressCommandK(page)
}

/** Types `query` until a result for `title` shows; the index catches up just after the commit. */
async function search(page: Page, query: string, title: string): Promise<void> {
  const result = page.getByTestId('search-result').filter({ hasText: title })
  await expect(async () => {
    await page.getByTestId('cmdk-input').fill(query)
    await expect(result.first()).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 5_000 })
}

test('Cmd-K finds a doc by its title and Enter opens it', async ({ page, api, user }) => {
  const id = uid()
  const title = `Kiln schedule ${id}`
  const file = `docs/e2e-search-title-${id}.md`
  await api.writeFile(user.team, file, `# ${title}\n\nFiring times for the week.\n`)

  await openCommandK(page)
  await search(page, title, title)
  await page.keyboard.press('Enter')

  await expect(page).toHaveURL(isDocUrl(user.team, file))
})

test('Cmd-K finds a doc by a word that appears only in its body', async ({ page, api, user }) => {
  const id = uid()
  const title = `Glaze notes ${id}`
  const bodyWord = `celadon${id}`
  const file = `docs/e2e-search-body-${id}.md`
  await api.writeFile(user.team, file, `# ${title}\n\nThe ${bodyWord} batch cracked again.\n`)

  await openCommandK(page)
  await search(page, bodyWord, title)
  await page.keyboard.press('Enter')

  await expect(page).toHaveURL(isDocUrl(user.team, file))
})
