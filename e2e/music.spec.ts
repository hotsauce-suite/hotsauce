import { expect, test } from './fixtures'

// Background music in a real browser (docs/PLAN-background-music.md, M8): Music in the account menu plays
// and pauses, the file is served so the browser can seek in it, and opening the microphone holds
// the music until the recording ends. The browser runs headless, so nothing is heard.

test('M8: plays from the account menu, holds while the microphone is open, and pauses', async ({
  page,
}) => {
  await page.goto('/docs')
  await page.getByTestId('account-menu').click()
  const button = page.getByTestId('menu-music')
  await expect(button).toContainText('Off')

  const served = page.waitForResponse((r) => r.url().endsWith('/music/soft-piano.mp3'))
  await button.click()
  await page.getByTestId('music-toggle').click()
  expect((await served).status()).toBeLessThan(400)
  await expect(page.getByTestId('music-status')).toHaveText('Playing')
  await expect(button).toHaveAttribute('data-playing', '')

  // A recording opens the microphone: the music waits, then comes back when it stops.
  await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    ;(window as unknown as { held: MediaStream }).held = stream
  })
  await expect(page.getByTestId('music-status')).toHaveText('Paused while recording')
  await page.evaluate(() => {
    for (const t of (window as unknown as { held: MediaStream }).held.getTracks()) t.stop()
  })
  await expect(page.getByTestId('music-status')).toHaveText('Playing', { timeout: 5000 })

  await page.getByTestId('music-track-rain').check()
  await expect(page.getByTestId('music-status')).toHaveText('Playing')
  await page.getByTestId('music-toggle').click()
  await expect(page.getByTestId('music-status')).toHaveText('Off')
  await expect(button).not.toHaveAttribute('data-playing', '')
})

test('M8: the music files answer a range request, so Safari can play them', async ({ request }) => {
  const r = await request.get('/music/rain.mp3', { headers: { Range: 'bytes=0-99' } })
  expect(r.status()).toBe(206)
  expect(r.headers()['content-type']).toContain('audio/mpeg')
  expect((await r.body()).length).toBe(100)
  // A track that isn't there is a 404, not the app's page.
  expect((await request.get('/music/missing.mp3')).status()).toBe(404)
})
