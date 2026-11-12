import { uid } from './fixtures'
import { expect, test } from './meetings-fixtures'

// R11: open Briefcast from the rail → make today's briefing → it plays and the script shows.
test('Briefcast makes today’s briefing from your meetings and plays it', async ({
  page,
  member,
}) => {
  const id = uid()
  const title = `Northwind pricing ${id}`
  const date = new Date(Date.now() - 3_600_000).toISOString()
  await member.api.writeFile(
    member.personal,
    `meetings/2026/11/northwind-${id}.md`,
    `---\ntype: meeting\ntitle: ${title}\ndate: ${date}\nattendees: []\n---\n# ${title}\n\n## Decisions\n\n- Ship tiered pricing\n`,
  )

  await page.goto('/docs')
  await page
    .getByRole('navigation', { name: /apps/i })
    .getByRole('link', { name: /Briefcast/ })
    .click()
  await expect(page).toHaveURL(/\/briefcast$/)

  // The index takes the commit just after it lands; make it until the script names the meeting.
  await expect(async () => {
    await page.getByTestId('briefcast-make').click()
    await expect(page.getByTestId('briefcast-script')).toContainText(title, { timeout: 2_000 })
  }).toPass({ timeout: 20_000 })
  await expect(page.getByTestId('briefcast-episode').getByRole('heading')).toContainText(
    'Briefcast for',
  )
  const audio = page.getByTestId('briefcast-audio')
  await expect(audio).toHaveAttribute('src', /^blob:/)
  await expect
    .poll(() => audio.evaluate((el: HTMLAudioElement) => el.duration), { timeout: 10_000 })
    .toBeGreaterThan(0.5)
  await page
    .getByRole('group', { name: 'Playback speed' })
    .getByRole('button', { name: '2×', exact: true })
    .click()
  expect(await audio.evaluate((el: HTMLAudioElement) => el.playbackRate)).toBe(2)

  // The private feed works without signing in, and stops when turned off.
  await page.getByTestId('briefcast-feed-make').click()
  const feedUrl = await page.getByTestId('briefcast-feed-url').inputValue()
  const path = new URL(feedUrl).pathname
  const anonymous = await page.context().browser()?.newContext()
  const feed = await anonymous?.request.get(new URL(path, page.url()).href)
  expect(feed?.status()).toBe(200)
  expect(await feed?.text()).toContain('<enclosure ')
  await page.getByRole('button', { name: 'Turn off' }).click()
  await expect(page.getByTestId('briefcast-feed-make')).toBeVisible()
  expect((await anonymous?.request.get(new URL(path, page.url()).href))?.status()).toBe(404)
  await anonymous?.close()

  // It's a file in the member's own space, so it survives a reload.
  await page.reload()
  await expect(page.getByTestId('briefcast-script')).toContainText(title)
})
