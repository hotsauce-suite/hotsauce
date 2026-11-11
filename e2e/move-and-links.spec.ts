import type { Page } from '@playwright/test'
import { docText, docUrl, expect, isDocUrl, test, uid } from './fixtures'

/** Clicks a link in the rendered document, switching to the reading view if needed. */
async function followLink(page: Page, name: string): Promise<void> {
  const view = page.getByTestId('reading-view')
  if (!(await view.isVisible())) await page.getByTestId('reading-toggle').click()
  await view.getByRole('link', { name }).click()
}

test('links between two docs still open the right doc after one moves', async ({
  page,
  api,
  user,
}) => {
  const id = uid()
  const folder = `docs/e2e-links-${id}`
  const alpha = `${folder}/alpha.md`
  const beta = `${folder}/beta.md`
  const movedBeta = `${folder}/archive/beta.md`
  await api.writeFile(user.team, alpha, `# Alpha ${id}\n\nSee [the beta doc](beta.md).\n`)
  await api.writeFile(user.team, beta, `# Beta ${id}\n\nBack to [the alpha doc](alpha.md).\n`)

  await api.move(user.team, beta, movedBeta)
  // The move rewrites the moved file's own relative links (ARCHITECTURE §3.2).
  expect((await api.readFile(user.team, movedBeta))?.content).toContain('](../alpha.md)')

  await page.goto(docUrl(user.team, movedBeta))
  await expect(docText(page)).toContainText(`Beta ${id}`)
  await followLink(page, 'the alpha doc')
  await expect(page).toHaveURL(isDocUrl(user.team, alpha))
  await expect(docText(page)).toContainText(`Alpha ${id}`)

  // The link into the moved doc survives the move too (Docs PRD §6, P0 item 6).
  await followLink(page, 'the beta doc')
  await expect(page).toHaveURL(isDocUrl(user.team, movedBeta))
  await expect(docText(page)).toContainText(`Beta ${id}`)
})
