import type { Page } from '@playwright/test'
import { expect, meSegment, parseMeetingUrl, test } from './meetings-fixtures'

// Runs only in the mobile-chromium project (Pixel 7: touch, no hover).

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    screen: document.documentElement.clientWidth,
  }))
  expect(widths.page).toBeLessThanOrEqual(widths.screen)
}

test('a phone records a voice note: named, summarised, sent to Tasks, deleted', async ({
  page,
  member,
}) => {
  // Dictate on a phone is the recorder, not the Mac download page.
  await page.goto('/dictate')
  await page.waitForURL(/\/dictate\/voice$/)
  await expect(page.getByTestId('voice-record')).toBeVisible()
  await expect(page.getByTestId('mac-app-download')).toHaveCount(0)
  await expect(page.getByTestId('voice-none')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Get the Mac app' })).toHaveAttribute(
    'href',
    '/settings#mac-app',
  )
  await expectNoSidewaysScroll(page)

  await page.getByTestId('voice-record').click()
  const recording = page.getByTestId('voice-recording')
  await expect(recording).toHaveAttribute('data-state', 'recording', { timeout: 5_000 })
  await expect(recording).toContainText('Keep this screen open')
  // No strip across the top: this page shows the recording itself.
  await expect(page.locator('a[data-testid="recording-indicator"]')).toHaveCount(0)
  await expect(page.getByTestId('voice-elapsed')).toHaveText(/^0:0[1-9]$/, { timeout: 5_000 })
  // The fake microphone plays a tone, so the wave moves.
  await expect
    .poll(() =>
      page
        .getByTestId('voice-wave')
        .locator('span')
        .evaluateAll((bars) => bars.some((b) => b.style.transform !== 'scaleY(0.08)')),
    )
    .toBe(true)
  await page.getByTestId('voice-transcript-toggle').click()
  await expect(meSegment(page, 'me segment 1')).toBeVisible({ timeout: 5_000 })

  await page.getByTestId('voice-pause').click()
  await expect(recording).toHaveAttribute('data-state', 'paused')
  await page.getByTestId('voice-pause').click()
  await expect(recording).toHaveAttribute('data-state', 'recording')
  await expect(page.getByTestId('voice-stop')).toBeInViewport()
  await expectNoSidewaysScroll(page)

  await page.getByTestId('voice-stop').click()
  await page.waitForURL((url) => url.pathname.includes('-voice-note.md'), { timeout: 10_000 })
  const { space, path } = parseMeetingUrl(page.url())
  expect(space).toBe(member.personal)
  // Enhance runs by itself and names the note from what was said.
  await expect(page.getByTestId('voice-note-actions')).toBeVisible({ timeout: 10_000 })
  await expect
    .poll(async () => (await member.api.readFile(space, path))?.content, { timeout: 10_000 })
    .toMatch(/^title: About me segment 1$/m)
  await expectNoSidewaysScroll(page)

  // A to-do in the note goes to Tasks once, however often the button is pressed.
  const file = await member.api.readFile(space, path)
  await member.api.writeFile(space, path, `${file?.content ?? ''}- [ ] call the plumber\n`)
  await page.reload()
  await page.getByTestId('voice-to-tasks').click()
  await expect(page.getByText('Added 1 to-do to Tasks.')).toBeVisible()
  await page.getByTestId('voice-to-tasks').click()
  await expect(page.getByText(/No to-dos left to send/)).toBeVisible()
  const tasks = await member.request.get('/api/tasks')
  expect(JSON.stringify(await tasks.json())).toContain('call the plumber')

  // The list on the voice page shows it under its new name.
  await page.goto('/dictate/voice')
  await expect(page.getByTestId('voice-notes')).toContainText('About me segment 1')
  await page.getByTestId('voice-notes').getByRole('link').first().click()
  await expect(page.getByTestId('voice-note-actions')).toBeVisible()

  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByTestId('voice-delete').click()
  await page.waitForURL(/\/dictate\/voice$/)
  await expect(page.getByTestId('voice-none')).toBeVisible()
  expect(await member.api.readFile(space, path)).toBeNull()
})

test('the home-screen icon opens voice notes, and its shortcut starts recording', async ({
  page,
  member: _member,
}) => {
  await page.goto('/?launch=home')
  await page.waitForURL(/\/dictate\/voice$/)
  await page.goto('/')
  await page.waitForURL(/\/today$/)

  await page.goto('/dictate/voice?start=1')
  const recording = page.getByTestId('voice-recording')
  await expect(recording).toHaveAttribute('data-state', 'recording', { timeout: 5_000 })
  await page.getByTestId('voice-stop').click()
  await page.waitForURL((url) => url.pathname.includes('-voice-note.md'), { timeout: 10_000 })

  const manifest = await (await page.request.get('/manifest.webmanifest')).json()
  expect(manifest.start_url).toBe('/?launch=home')
  expect(manifest.shortcuts?.[0]?.url).toBe('/dictate/voice?start=1')
})

test('when the phone takes the microphone away, one tap brings it back', async ({
  page,
  member: _member,
}) => {
  // Keep hold of every microphone the page opens, to take it away as the phone would.
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    const kept: MediaStream[] = []
    ;(window as unknown as { __mics: MediaStream[] }).__mics = kept
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await original(constraints)
      kept.push(stream)
      return stream
    }
  })
  await page.goto('/dictate/voice')
  await page.getByTestId('voice-record').click()
  const recording = page.getByTestId('voice-recording')
  await expect(recording).toHaveAttribute('data-state', 'recording', { timeout: 5_000 })
  await expect(page.getByTestId('voice-resume-mic')).toHaveCount(0)

  await page.evaluate(() => {
    for (const stream of (window as unknown as { __mics: MediaStream[] }).__mics) {
      for (const track of stream.getTracks()) {
        // A browser fires "ended" when the system takes the track; stop() alone doesn't.
        track.stop()
        track.dispatchEvent(new Event('ended'))
      }
    }
  })
  await expect(recording).toContainText('Not hearing the microphone', { timeout: 5_000 })
  await page.getByTestId('voice-resume-mic').click()
  await expect(page.getByTestId('voice-resume-mic')).toHaveCount(0, { timeout: 5_000 })
  await expect(recording).toContainText('Recording')
  await page.getByTestId('voice-stop').click()
  await page.waitForURL((url) => url.pathname.includes('-voice-note.md'), { timeout: 10_000 })
})
