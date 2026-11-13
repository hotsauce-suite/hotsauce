import { expect, test } from './meetings-fixtures'

// Plan L3: a voice note from the keyboard. r starts it, ⌥⌘P pauses and resumes, r stops and
// saves it. Chromium's fake microphone stands in for a real one.

test('r starts a voice note, ⌥⌘P pauses and resumes it, r stops and saves it', async ({
  page,
  member,
}) => {
  void member
  await page.goto('/dictate/voice')
  await expect(page.getByTestId('voice-record')).toBeVisible()
  await page.keyboard.press('r')
  const recording = page.getByTestId('voice-recording')
  await expect(recording).toHaveAttribute('data-state', 'recording', { timeout: 5_000 })
  await expect(page.getByTestId('voice-elapsed')).toHaveText(/^0:0[1-9]$/, { timeout: 5_000 })

  await page.keyboard.press('ControlOrMeta+Alt+KeyP')
  await expect(recording).toHaveAttribute('data-state', 'paused')
  await page.keyboard.press('ControlOrMeta+Alt+KeyP')
  await expect(recording).toHaveAttribute('data-state', 'recording')

  await page.keyboard.press('r')
  await page.waitForURL((url) => url.pathname.includes('-voice-note.md'), { timeout: 10_000 })
})
