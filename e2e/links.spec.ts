import { expect, test, uid } from './fixtures'

// Saved links (ARCHITECTURE §23): a member pastes a link,
// sees the readable copy arrive, tags it, shares it with the team, marks it done; then the save
// page (what the extension and the phone's share sheet open) saves a second one. Pages come
// from the server's stand-in fetcher (LINK_FETCH=fake under NODE_ENV=test).

test('save a link, read it, tag it, share it and mark it done', async ({ page }) => {
  const id = uid()
  const url = `https://journal.test/${id}/mirror-life`
  await page.goto('/links')
  await page.getByTestId('links-paste').fill(url)
  await page.getByRole('button', { name: 'Save' }).click()

  const row = page.getByTestId('link-row').filter({ hasText: 'Mirror life' })
  await expect(row).toBeVisible()
  await expect(row).toContainText('Mirror life, in a sentence.')
  await expect(row).toContainText('reading')

  await row.getByTestId('link-title').click()
  await expect(page.getByTestId('link-reader-title')).toHaveText('Mirror life')
  await expect(page.getByTestId('link-body')).toContainText(
    'Mirror life is the subject of this page.',
  )
  await expect(page.getByTestId('link-original')).toHaveAttribute('href', url)
  await expect(page.getByTestId('link-short')).toHaveCount(0)

  await page.getByTestId('link-edit-tags').click()
  await page.getByTestId('link-tags-input').fill(`biosecurity, e2e ${id}`)
  await page.getByTestId('link-tags-input').press('Enter')
  await expect(page.getByRole('link', { name: `e2e ${id}` })).toBeVisible()

  await page.getByTestId('link-share-team').click()
  await expect(page).toHaveURL(/\/links\/team\//)
  await expect(page.getByTestId('link-share-team')).toHaveCount(0)

  await page.getByTestId('link-reader-done').click()
  await expect(page).toHaveURL(/\/links$/)
  await expect(page.getByTestId('link-row').filter({ hasText: 'Mirror life' })).toHaveCount(0)
  await page.getByTestId('links-view-archive').click()
  await expect(page.getByTestId('link-row').filter({ hasText: `e2e ${id}` })).toBeVisible()
})

test('a copy that came through cut short can be read again', async ({ page }) => {
  const id = uid()
  await page.goto(
    `/links/save?url=${encodeURIComponent(`https://forum.stub.test/${id}/big-projects`)}`,
  )
  await page.getByTestId('link-save-confirm').click()
  await expect(page.getByTestId('link-saved')).toHaveText('Saved')
  await page.getByRole('link', { name: 'Open it' }).click()
  await expect(page.getByTestId('link-body')).toContainText('cut short')
  await expect(page.getByTestId('link-short')).toContainText(
    'Only part of the page may have come through.',
  )
  await page.screenshot({ path: 'test-results/link-short.png' })
  await page.getByRole('button', { name: 'Get the page again' }).click()
  await expect(page.getByTestId('link-body')).toContainText('cut short')
  await expect(page.getByTestId('link-short')).toBeVisible()
})

test('the save page asks, saves what was shared once, and a dead site can be tried again', async ({
  page,
}) => {
  const id = uid()
  const shared = encodeURIComponent(`Worth a read https://news.test/${id}/gene-drives`)
  await page.goto(`/links/save?text=${shared}&title=Gene%20drives&via=share`)
  await page.getByTestId('link-save-confirm').click()
  await expect(page.getByTestId('link-saved')).toHaveText('Saved')
  await page.reload()
  await page.getByTestId('link-save-confirm').click()
  await expect(page.getByTestId('link-saved')).toHaveText('Already saved')

  await page.goto(`/links/save?url=${encodeURIComponent(`https://down.fail.test/${id}`)}`)
  await page.getByTestId('link-save-confirm').click()
  await expect(page.getByTestId('link-saved')).toHaveText('Saved')
  await page.getByRole('link', { name: 'Open it' }).click()
  await expect(page.getByTestId('link-failed')).toContainText('Couldn’t reach the site')
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
})

test('Links works at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/links')
  await expect(page.getByTestId('links-paste')).toBeVisible()
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
})

test('a long read picks up where you left off, and the list shows how far you got', async ({
  page,
}) => {
  const id = uid()
  await page.goto(
    `/links/save?url=${encodeURIComponent(`https://essay.long.test/${id}/slow-read`)}`,
  )
  await page.getByTestId('link-save-confirm').click()
  await expect(page.getByTestId('link-saved')).toHaveText('Saved')
  await page.getByRole('link', { name: 'Open it' }).click()
  await expect(page.getByTestId('link-body')).toContainText('Part 40')
  await expect(page.getByTestId('link-resumed')).toHaveCount(0)

  // Read to Part 20 and stop: the place is saved a moment after scrolling stops.
  const saved = page.waitForRequest(
    (r) => r.method() === 'PUT' && r.url().endsWith('/reading') && r.postDataJSON().anchor > 10,
  )
  await page.getByRole('heading', { name: 'Part 20', exact: true }).evaluate((el) => {
    el.scrollIntoView({ block: 'start' })
  })
  const place = (await saved).postDataJSON() as { anchor: number; percent: number }
  expect(place.percent).toBeGreaterThan(30)
  expect(place.percent).toBeLessThan(80)

  await page.getByRole('link', { name: 'Links' }).first().click()
  const row = page.getByTestId('link-row').filter({ hasText: 'Slow read' })
  await expect(row).toContainText(/\d+% read/)
  await expect(row.getByTestId('link-progress-bar')).toBeVisible()
  await page.screenshot({ path: 'test-results/link-progress.png' })

  await row.getByTestId('link-title').click()
  await expect(page.getByTestId('link-resumed')).toContainText('Picked up where you left off')
  await expect(page.getByRole('heading', { name: 'Part 20', exact: true })).toBeInViewport()
  await expect(page.getByTestId('link-reader-title')).not.toBeInViewport()
  await page.screenshot({ path: 'test-results/link-resumed.png' })

  await page.getByTestId('link-start-over').click()
  await expect(page.getByTestId('link-reader-title')).toBeInViewport()
  await expect(page.getByTestId('link-resumed')).toHaveCount(0)

  // The end of the article has its own Done.
  await page.getByTestId('link-end-done').scrollIntoViewIfNeeded()
  await page.getByTestId('link-end-done').click()
  await expect(page).toHaveURL(/\/links$/)
  await expect(page.getByTestId('link-row').filter({ hasText: 'Slow read' })).toHaveCount(0)
})
