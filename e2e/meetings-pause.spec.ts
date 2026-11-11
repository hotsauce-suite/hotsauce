import { uid } from './fixtures'
import {
  expect,
  getSession,
  meSegment,
  parseMeetingUrl,
  startMicOnly,
  test,
  transcriptPath,
} from './meetings-fixtures'

test('pause holds the recording and resume carries it on', async ({ page, member }) => {
  const title = `Pause check ${uid()}`
  await page.goto('/meetings/start')
  await page.getByTestId('start-title').fill(title)
  const id = await startMicOnly(page)
  const indicator = page.getByTestId('recording-indicator')
  await expect(page).toHaveTitle(`● Recording · ${title}`)
  await expect(meSegment(page, 'me segment 1')).toBeVisible({ timeout: 5_000 })

  await page.getByTestId('pause').click()
  await expect(indicator).toHaveAttribute('data-state', 'paused')
  await expect(page.getByTestId('resume')).toBeVisible()
  await expect(page).toHaveTitle(`Paused · ${title}`)
  // Once the server has the pause, the audio sent before it is all transcribed.
  await expect.poll(async () => (await getSession(member, id)).state).toBe('paused')
  const heard = (await getSession(member, id)).segments.length
  // Longer than one segment of audio (1 s): still recording, this would add a segment.
  await page.waitForTimeout(1_500)
  expect((await getSession(member, id)).segments.length).toBe(heard)

  await page.getByTestId('resume').click()
  await expect(indicator).toHaveAttribute('data-state', 'recording')
  await expect(page.getByTestId('pause')).toBeVisible()
  await expect(page).toHaveTitle(`● Recording · ${title}`)
  await expect.poll(async () => (await getSession(member, id)).state).toBe('recording')
  await expect(meSegment(page, `me segment ${heard + 1}`)).toBeVisible({ timeout: 5_000 })

  // The transcript's clock counts recorded audio only: the paused stretch leaves no gap.
  await page.getByTestId('stop').click()
  await page.waitForURL((url) => url.pathname.endsWith('.md'), { timeout: 10_000 })
  const note = parseMeetingUrl(page.url())
  const transcript = await member.api.readFile(note.space, transcriptPath(note.path))
  const stamp = `[00:00:${String(heard).padStart(2, '0')}]`
  expect(transcript?.content).toContain(`${stamp} **Me:** me segment ${heard + 1}\n`)
})
