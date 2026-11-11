import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// ARCHITECTURE §10.5: Hearth Clips against the built server, with Chromium's fake camera,
// microphone and screen (the share picker answers itself), FakeClipTranscriber and FakeLLM.

const video = (page: Page) => page.getByTestId('clip-video')

async function videoState(page: Page) {
  return video(page).evaluate((el: HTMLVideoElement) => ({
    duration: el.duration,
    currentTime: el.currentTime,
    playbackRate: el.playbackRate,
    seekableEnd: el.seekable.length ? el.seekable.end(el.seekable.length - 1) : 0,
    readyState: el.readyState,
  }))
}

test('record screen and camera, stop from the bubble, watch, change speed, follow the transcript', async ({
  page,
  context,
  user,
  playwright,
  baseURL,
}) => {
  let clipId = ''

  await test.step('Clips opens from the app switch; the recorder shows the camera', async () => {
    await page.goto('/docs')
    await page.getByTestId('app-switch-clips').click()
    await expect(page).toHaveURL(/\/clips$/)
    await page.getByTestId('record-clip').click()
    await expect(page).toHaveURL(/\/clips\/new$/)
    await expect(page.getByTestId('clip-mode-screen_camera').locator('input')).toBeChecked()
    await expect(page.getByTestId('camera-preview').locator('video')).toBeVisible()
  })

  await test.step('start: the picker, the bubble window, a 3-2-1 countdown, then recording', async () => {
    const bubble = context.waitForEvent('page')
    await page.getByTestId('clip-start').click()
    await expect(page.getByTestId('countdown')).toBeVisible()
    await expect(page.getByTestId('recording-timer')).toBeVisible({ timeout: 6_000 })
    const pip = await bubble
    await expect(pip.getByTestId('clip-bubble').locator('video')).toBeVisible()
    await expect(pip.getByTestId('bubble-timer')).toBeVisible()
  })

  await test.step('pause holds the timer; resume carries on', async () => {
    await expect(page.getByTestId('recording-timer')).toHaveText('0:02', { timeout: 5_000 })
    await page.getByTestId('clip-pause').click()
    const paused = await page.getByTestId('recording-timer').textContent()
    await page.waitForTimeout(1500)
    await expect(page.getByTestId('recording-timer')).toHaveText(paused ?? '')
    await page.getByTestId('clip-pause').click()
    await expect(page.getByTestId('recording-timer')).toHaveText('0:05', { timeout: 6_000 })
  })

  await test.step('Stop in the bubble saves and opens the clip', async () => {
    const pip = context.pages().find((p) => p !== page)
    if (!pip) throw new Error('the bubble window is gone')
    await pip.getByTestId('bubble-stop').click()
    await page.waitForURL(/\/clips\/[0-9A-Z]{26}$/, { timeout: 15_000 })
    clipId = page.url().split('/').pop() ?? ''
    await expect.poll(() => context.pages().length).toBe(1)
  })

  await test.step('the video plays and seeks, with the right duration', async () => {
    await expect(video(page)).toBeVisible({ timeout: 20_000 })
    await expect
      .poll(async () => (await videoState(page)).readyState, { timeout: 10_000 })
      .toBeGreaterThan(0)
    const { duration, seekableEnd } = await videoState(page)
    // About five seconds recorded, minus the pause.
    expect(duration).toBeGreaterThan(4)
    expect(duration).toBeLessThan(9)
    expect(Number.isFinite(duration)).toBe(true)
    expect(seekableEnd).toBeGreaterThan(duration - 0.5)
    await expect(page.getByTestId('clip-meta')).toContainText(`0:0${Math.floor(duration)}`)

    await video(page).evaluate((el: HTMLVideoElement) => {
      el.muted = true
      el.currentTime = 3
    })
    await expect.poll(async () => (await videoState(page)).currentTime).toBeCloseTo(3, 0)
    await video(page).evaluate((el: HTMLVideoElement) => el.play())
    await expect
      .poll(async () => (await videoState(page)).currentTime, { timeout: 5_000 })
      .toBeGreaterThan(3.2)
    await video(page).evaluate((el: HTMLVideoElement) => el.pause())
  })

  await test.step('speed: the buttons set the rate, the keyboard steps it, and it is remembered', async () => {
    await page.getByTestId('clip-speed-1.5').click()
    expect((await videoState(page)).playbackRate).toBe(1.5)
    await expect(page.getByTestId('clip-speed-1.5')).toHaveAttribute('aria-pressed', 'true')
    await page.locator('body').press('>')
    expect((await videoState(page)).playbackRate).toBe(1.75)
    await page.locator('body').press('<')
    await page.locator('body').press('<')
    expect((await videoState(page)).playbackRate).toBe(1.2)
    await page.reload()
    await expect(video(page)).toBeVisible()
    await expect.poll(async () => (await videoState(page)).playbackRate).toBe(1.2)
    await expect(page.getByTestId('clip-speed-1.2')).toHaveAttribute('aria-pressed', 'true')
  })

  await test.step('the transcript appears, clicking a line seeks there, and it highlights', async () => {
    const lines = page.getByTestId('transcript-line')
    await expect(lines.first()).toContainText('clip segment 1', { timeout: 15_000 })
    await expect(lines.nth(1)).toContainText('0:02')
    await lines.nth(1).click()
    await expect.poll(async () => (await videoState(page)).currentTime).toBeGreaterThanOrEqual(2)
    await video(page).evaluate((el: HTMLVideoElement) => el.pause())
    await expect(lines.nth(1)).toHaveAttribute('aria-current', 'true')
    // The suggested title (FakeLLM names it after the first line) and the summary.
    await expect(page.getByTestId('clip-title')).toHaveText('About clip segment 1')
    await expect(page.getByTestId('clip-summary')).toContainText('clip segment 1')
  })

  await test.step('rename, then find it in the library by title and by transcript', async () => {
    await page.getByTestId('clip-rename').click()
    await page.getByTestId('clip-title-input').fill('Walkthrough of the bubble')
    await page.getByTestId('clip-title-input').press('Enter')
    await expect(page.getByTestId('clip-title')).toHaveText('Walkthrough of the bubble')

    await page.goto('/clips')
    const card = page.getByTestId('clip-card').filter({ hasText: 'Walkthrough of the bubble' })
    await expect(card).toBeVisible()
    await expect
      .poll(() => card.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0)
    await page.getByTestId('clips-search').fill('segment 2')
    await expect(card).toBeVisible()
    await page.getByTestId('clips-search').fill('no clip says this')
    await expect(card).toBeHidden()
  })

  await test.step('another member watches but cannot delete', async () => {
    const other = await playwright.request.newContext({
      baseURL: baseURL as string,
      extraHTTPHeaders: { 'x-hearth-dev-user': `viewer-${Date.now()}@example.test` },
    })
    const seen = await other.get(`/api/clips/${clipId}`)
    expect(seen.status()).toBe(200)
    expect((await seen.json()).clip.isOwner).toBe(false)
    expect((await other.delete(`/api/clips/${clipId}`)).status()).toBe(403)
    const team = await other.get('/api/clips?scope=team')
    expect((await team.json()).clips.map((c: { id: string }) => c.id)).toContain(clipId)
    await other.dispose()
  })

  await test.step('the owner deletes it', async () => {
    await page.goto(`/clips/${clipId}`)
    await page.getByTestId('clip-delete').click()
    await page.getByTestId('clip-delete-confirm').click()
    await expect(page).toHaveURL(/\/clips$/)
    await expect(page.getByTestId('clip-card').filter({ hasText: 'Walkthrough' })).toHaveCount(0)
    const owner = await playwright.request.newContext({
      baseURL: baseURL as string,
      extraHTTPHeaders: { 'x-hearth-dev-user': user.email },
    })
    expect((await owner.get(`/api/clips/${clipId}`)).status()).toBe(404)
    await owner.dispose()
  })
})

test('camera only, discard part way, then record and stop from the page', async ({
  page,
  user,
  playwright,
  baseURL,
}) => {
  const owner = await playwright.request.newContext({
    baseURL: baseURL as string,
    extraHTTPHeaders: { 'x-hearth-dev-user': user.email },
  })
  const cameraClips = async () => {
    const res = await (await owner.get('/api/clips?scope=mine')).json()
    return res.clips.filter((c: { mode: string }) => c.mode === 'camera').length
  }
  const before = await cameraClips()
  await page.goto('/clips/new')
  await page.getByTestId('clip-mode-camera').click()
  await expect(page.getByTestId('camera-preview').locator('video')).toBeVisible()
  await page.getByTestId('clip-start').click()
  await expect(page.getByTestId('recording-timer')).toBeVisible({ timeout: 6_000 })
  await page.getByTestId('clip-cancel').click()
  await expect(page.getByTestId('clip-start')).toBeEnabled()
  await expect(page.getByTestId('clip-recorder')).toHaveAttribute('data-phase', 'idle')

  await page.getByTestId('clip-start').click()
  await expect(page.getByTestId('recording-timer')).toHaveText('0:02', { timeout: 8_000 })
  await page.getByTestId('clip-stop').click()
  await page.waitForURL(/\/clips\/[0-9A-Z]{26}$/, { timeout: 15_000 })
  await expect(video(page)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('transcript-line').first()).toContainText('clip segment 1', {
    timeout: 15_000,
  })
  // The discarded recording left nothing behind.
  expect(await cameraClips()).toBe(before + 1)
  await owner.dispose()
})
