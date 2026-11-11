import type { Page } from '@playwright/test'
import { docText, uid } from './fixtures'
import {
  expect,
  meSegment,
  parseMeetingUrl,
  startMicOnly,
  test,
  typeNotes,
} from './meetings-fixtures'

// Runs only in the mobile-chromium project (Pixel 7 viewport, touch).

/**
 * Nothing on the page is wider than the screen: the page doesn't scroll sideways, no scroll
 * container does, and no element sticks out past either edge.
 */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const offenders = await page.evaluate(() => {
    const width = document.documentElement.clientWidth
    const found: string[] = []
    const name = (el: Element) =>
      `${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''}.${String(el.className).slice(0, 60)}`
    if (document.documentElement.scrollWidth > width) {
      found.push(`page scrolls to ${document.documentElement.scrollWidth}px of ${width}px`)
    }
    for (const el of document.body.querySelectorAll('*')) {
      const style = getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none') continue
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      // Off-canvas (a closed drawer) is fine; straddling an edge is not.
      const straddles =
        (rect.left < -1 && rect.right > 1) || (rect.left < width - 1 && rect.right > width + 1)
      if (straddles)
        found.push(`${name(el)} spans ${Math.round(rect.left)}..${Math.round(rect.right)}px`)
      if (/(auto|scroll)/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1) {
        found.push(`${name(el)} scrolls sideways (${el.scrollWidth}px in ${el.clientWidth}px)`)
      }
    }
    return found
  })
  expect(offenders).toEqual([])
}

test('a phone takes notes: home, Start and a mic-only recording fit the screen', async ({
  page,
  member,
}) => {
  const line = `Noted on a phone ${uid()}`

  await page.goto('/meetings')
  const event = page.getByTestId('calendar-event').filter({ hasText: 'Acme sync' })
  await expect(event.getByTestId('take-notes')).toBeVisible()
  await expect(page.getByTestId('meeting-list')).toBeVisible()
  await expectNoHorizontalOverflow(page)

  await event.getByTestId('take-notes').click()
  await expect(page.getByTestId('start-title')).toHaveValue('Acme sync')
  await expect(page.getByTestId('start-recording')).toBeVisible()
  await expectNoHorizontalOverflow(page)

  await startMicOnly(page)
  await expect(meSegment(page, 'me segment 1')).toBeVisible({ timeout: 5_000 })
  await expect(page.getByTestId('stop')).toBeInViewport()
  await expectNoHorizontalOverflow(page)
  await typeNotes(page, line)

  await page.getByTestId('stop').click()
  await page.waitForURL((url) => url.pathname.endsWith('-acme-sync.md'), { timeout: 10_000 })
  expect(parseMeetingUrl(page.url()).space).toBe(member.personal)
  await expect(page.getByTestId('ai-text').first()).toBeVisible({ timeout: 10_000 })
  await expect(docText(page)).toContainText(line)
  await expectNoHorizontalOverflow(page)
})
