import { expect, test } from './meetings-fixtures'

// Today on a phone (Pixel 7), plan E6 and E7: the columns read as one list, and tiles move freely
// through it, by the arrows and by dragging the handle with a finger.

test.use({ timezoneId: 'UTC' })

test('J2: on a phone, Edit Today is at the bottom and tiles move freely through the whole list', async ({
  page,
  member,
}) => {
  const reset = await member.request.put('/api/today/layout', {
    data: {
      layout: {
        schema: 1,
        columns: [
          [
            { id: 'meetings', kind: 'meetings' },
            { id: 'tasks', kind: 'tasks' },
          ],
          [
            { id: 'docs', kind: 'docs' },
            { id: 'brief', kind: 'brief' },
          ],
        ],
      },
    },
  })
  expect(reset.status(), await reset.text()).toBe(200)
  const order = () =>
    page.getByTestId('today-edit-tile').evaluateAll((els) => els.map((e) => e.dataset.tileId))

  await page.goto('/today')
  await expect(page.getByTestId('today-tasks')).toBeVisible()
  // E7: the button comes after every tile.
  const below = await page.evaluate(() => {
    const edit = document.querySelector('[data-testid="today-edit"]')?.getBoundingClientRect()
    const tiles = document.querySelector('[data-testid="today-tiles"]')?.getBoundingClientRect()
    return edit && tiles ? edit.top >= tiles.bottom : false
  })
  expect(below).toBe(true)
  await page.getByTestId('today-edit').tap()
  await expect(page.getByTestId('today-edit-bar')).toBeInViewport()
  await expect(page.getByTestId('today-tile-across')).toHaveCount(0)

  // E6: down from the bottom of the left column carries on into the right one.
  const tasks = page.getByTestId('today-edit-tile').filter({ has: page.getByTestId('today-tasks') })
  await tasks.getByTestId('today-tile-down').tap()
  expect(await order()).toEqual(['meetings', 'docs', 'tasks', 'brief'])

  // E6: drag Brief (the very bottom) by its handle with a finger, up above Meetings (the top).
  await page.getByTestId('today').evaluate((el) => el.scrollTo(0, 0))
  const grip = page
    .getByTestId('today-edit-tile')
    .filter({ has: page.getByTestId('today-brief') })
    .getByTestId('today-tile-grip')
  await grip.scrollIntoViewIfNeeded()
  const from = await grip.boundingBox()
  if (!from) throw new Error('no grip')
  const cdp = await page.context().newCDPSession(page)
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x = 0, y = 0) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
    })
  const x = from.x + from.width / 2
  await touch('touchStart', x, from.y + from.height / 2)
  // Hold near the top edge until the page has scrolled to the top.
  const scroller = page.getByTestId('today')
  const top = (await scroller.boundingBox())?.y ?? 0
  for (let i = 0; i < 200; i++) {
    await touch('touchMove', x, top + 10)
    if ((await scroller.evaluate((el) => el.scrollTop)) === 0) break
    await page.waitForTimeout(20)
  }
  await expect(page.getByTestId('today-drag-ghost')).toHaveText('Agent brief')
  const meetings = await page
    .getByTestId('today-edit-tile')
    .filter({ has: page.getByTestId('today-meetings') })
    .boundingBox()
  if (!meetings) throw new Error('no meetings tile')
  await touch('touchMove', x, meetings.y + 40)
  await expect(page.getByTestId('today-drop-marker')).toHaveAttribute('data-side', 'before')
  await touch('touchEnd')
  expect(await order()).toEqual(['brief', 'meetings', 'docs', 'tasks'])

  await page.getByTestId('today-done').tap()
  await expect(page.getByTestId('today-edit-bar')).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('today-brief')).toBeVisible()
  const saved = await member.request.get('/api/today/layout')
  const layout = (await saved.json()).layout
  expect(layout.columns.flat().map((t: { id: string }) => t.id)).toEqual([
    'brief',
    'meetings',
    'docs',
    'tasks',
  ])
})
