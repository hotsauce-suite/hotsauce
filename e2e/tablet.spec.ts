import { docUrl, expect, test, uid } from './fixtures'

// An upright iPad Air (820 × 1180) with touch: between the phone layout and a laptop
// (docs/PLAN-ipad.md). Runs in the desktop project with a tablet-sized window.
test.use({ viewport: { width: 820, height: 1180 }, hasTouch: true })

const right = async (locator: import('@playwright/test').Locator) => {
  const box = await locator.boundingBox()
  if (!box) throw new Error('not rendered')
  return box.x + box.width
}

test('T3: the doc top bar fits an upright iPad', async ({ page, api, user }) => {
  const file = `docs/e2e-tablet-${uid()}.md`
  await api.writeFile(user.team, file, '# Tablet\n\nHello from an iPad.\n')
  await page.goto(docUrl(user.team, file))
  await expect(page.getByTestId('editor-content')).toContainText('Hello from an iPad.')
  const share = page.getByTestId('share-menu')
  await expect(share).toBeVisible()
  expect(await right(share)).toBeLessThanOrEqual(820)
  expect(
    await right(page.getByRole('button', { name: 'Save version', exact: true })),
  ).toBeLessThanOrEqual(820)
})

test('T1: History floats over the page instead of squeezing it', async ({ page, api, user }) => {
  const file = `docs/e2e-tablet-${uid()}.md`
  await api.writeFile(user.team, file, '# Tablet\n\nHello from an iPad.\n')
  await page.goto(docUrl(user.team, file))
  const editor = page.getByTestId('editor-content')
  await expect(editor).toContainText('Hello from an iPad.')
  const before = (await editor.boundingBox())?.width ?? 0
  await page.getByTestId('history-toggle').tap()
  const panel = page.getByRole('complementary', { name: 'History' })
  await expect(panel).toBeInViewport({ ratio: 1 })
  expect((await editor.boundingBox())?.width).toBe(before)
  // Under the top bar, so its buttons stay reachable.
  await page.getByTestId('history-toggle').tap()
  await expect(panel).toBeHidden()
})

test('T1: task details float over the list', async ({ page }) => {
  const title = `Order pipettes ${uid()}`
  await page.goto('/tasks/today')
  await page.getByTestId('tasks-add').tap()
  await page.getByTestId('quick-add-input').fill(`${title} today`)
  await page.getByTestId('quick-add-submit').tap()
  const row = page.getByTestId('task-row').filter({ hasText: title })
  await expect(row).toBeVisible()
  const before = (await row.boundingBox())?.width ?? 0
  expect(before).toBeGreaterThan(300)
  await row.getByTestId('task-open').tap()
  await expect(page.getByTestId('task-detail')).toBeInViewport({ ratio: 1 })
  expect((await row.boundingBox())?.width).toBe(before)
})

test.describe('sideways', () => {
  test.use({ viewport: { width: 1180, height: 820 } })

  test('T2: History sits beside the page on a wide screen', async ({ page, api, user }) => {
    const file = `docs/e2e-tablet-${uid()}.md`
    await api.writeFile(user.team, file, '# Tablet\n\nHello sideways.\n')
    await page.goto(docUrl(user.team, file))
    const editor = page.getByTestId('editor-content')
    await expect(editor).toContainText('Hello sideways.')
    await page.getByTestId('history-toggle').tap()
    const panel = page.getByRole('complementary', { name: 'History' })
    await expect(panel).toBeVisible()
    const panelBox = await panel.boundingBox()
    expect(await right(editor)).toBeLessThanOrEqual(panelBox?.x ?? 0)
  })
})
