import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from './fixtures'

// Runs only in the mobile-chromium project (Pixel 7). The clip is uploaded through the API the
// recorder uses; a phone watches clips, it doesn't record them.

const run = promisify(execFile)

test('a clip page fits a phone: video, speed and transcript', async ({
  page,
  user,
  playwright,
  baseURL,
}) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hearth-clip-'))
  const file = path.join(dir, 'clip.webm')
  await run('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    ...['-f', 'lavfi', '-i', 'testsrc2=size=640x400:rate=15:duration=5'],
    ...['-f', 'lavfi', '-i', 'sine=frequency=330:duration=5'],
    ...['-c:v', 'libvpx', '-b:v', '400k', '-c:a', 'libopus', '-live', '1', '-f', 'webm', file],
  ])
  const bytes = await readFile(file)
  await rm(dir, { recursive: true, force: true })

  const owner = await playwright.request.newContext({
    baseURL: baseURL as string,
    extraHTTPHeaders: { 'x-hearth-dev-user': user.email },
  })
  const clip = await (
    await owner.post('/api/clips', { data: { mode: 'screen', container: 'webm' } })
  ).json()
  const half = Math.ceil(bytes.length / 2)
  for (const [seq, part] of [bytes.subarray(0, half), bytes.subarray(half)].entries()) {
    const res = await owner.put(`/api/clips/${clip.id}/chunks/${seq}`, {
      data: part,
      headers: { 'content-type': 'application/octet-stream' },
    })
    expect(res.status()).toBe(204)
  }
  expect((await owner.post(`/api/clips/${clip.id}/finish`, { data: { chunks: 2 } })).ok()).toBe(
    true,
  )
  await owner.dispose()

  await page.goto(`/clips/${clip.id}`)
  await expect(page.getByTestId('clip-video')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('transcript-line').first()).toContainText('clip segment 1', {
    timeout: 15_000,
  })
  await expect(page.getByTestId('clip-speed-2')).toBeVisible()
  await page.getByTestId('clip-speed-2').click()
  await expect
    .poll(() => page.getByTestId('clip-video').evaluate((v: HTMLVideoElement) => v.playbackRate))
    .toBe(2)

  // Nothing wider than the screen.
  const overflow = await page.evaluate(() => {
    const width = document.documentElement.clientWidth
    return [...document.querySelectorAll('[data-testid="clip-page"] *')]
      .filter((el) => el.getBoundingClientRect().right > width + 1)
      .map(
        (el) =>
          el.tagName + (el.getAttribute('data-testid') ? `#${el.getAttribute('data-testid')}` : ''),
      )
  })
  expect(overflow).toEqual([])
  const box = await page.getByTestId('clip-video').boundingBox()
  expect(box?.width).toBeGreaterThan(300)

  await page.getByTestId('transcript-line').nth(1).click()
  await expect
    .poll(() => page.getByTestId('clip-video').evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThanOrEqual(2)
  await page.screenshot({ path: 'test-results/clips-mobile.png', fullPage: false })

  await page.goto('/clips')
  await expect(page.getByTestId('clip-card').first()).toBeVisible()
})
