import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Page } from '@playwright/test'
import { expect, openApp, test } from './fixtures'

const run = promisify(execFile)

/** Where the e2e server keeps a clip's files (AUDIO_STORE=local). */
function clipFile(id: string, name: string): string {
  return path.join(process.env.HEARTH_E2E_DATA_DIR ?? '', 'kept-audio', 'clips', id, name)
}

/** One pixel's RGB from `file` at `seconds` (a 2×2 crop on even coordinates, for yuv420). */
async function pixel(file: string, seconds: number, x: number, y: number): Promise<number[]> {
  const { stdout } = await run(
    'ffmpeg',
    [
      '-v',
      'error',
      '-ss',
      String(seconds),
      '-i',
      file,
      '-frames:v',
      '1',
      '-vf',
      `crop=2:2:${x - (x % 2)}:${y - (y % 2)}`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { encoding: 'buffer' },
  )
  return [...(stdout as Buffer).subarray(0, 3)]
}

async function videoHeight(file: string): Promise<number> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=height',
    '-of',
    'csv=p=0',
    file,
  ])
  return Number(stdout.trim())
}

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
  // A whole journey: record, wait for the server to put the camera in, then watch and edit.
  test.setTimeout(120_000)
  let clipId = ''
  /** What the recording timer said when Stop was pressed, in seconds. */
  let recordedSeconds = 0
  const seconds = (t: string | null) => {
    const [m, s] = (t ?? '0:00').split(':').map(Number)
    return (m ?? 0) * 60 + (s ?? 0)
  }

  await test.step('Clips opens from the launcher; the recorder shows the camera', async () => {
    await page.goto('/docs')
    await openApp(page, 'clips')
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
  })

  await test.step('the floating window says what it records, and the mic meter moves', async () => {
    const pip = context.pages().find((p) => p !== page)
    if (!pip) throw new Error('the bubble window is gone')
    const status = pip.getByTestId('recording-status')
    await expect(status).toContainText('Recording')
    await expect(status.getByTestId('status-timer')).toHaveText(/0:0\d/)
    await expect(status.getByTestId('status-screen')).toContainText(/screen|window|tab/i)
    await expect(status.getByTestId('status-mic')).not.toHaveText('No microphone')
    await expect(status.getByTestId('status-camera')).toContainText(/\S/)
    // Chromium's fake mic beeps: the meter must move.
    const levels = await status.getByTestId('status-mic-level').evaluate(
      (el) =>
        new Promise<number[]>((resolve) => {
          const seen: number[] = []
          const timer = setInterval(
            () => seen.push(Number((el as HTMLElement).dataset.level ?? 0)),
            20,
          )
          setTimeout(() => {
            clearInterval(timer)
            resolve(seen)
          }, 2500)
        }),
    )
    expect(Math.max(...levels)).toBeGreaterThan(0.02)
    // The page shows the same status.
    await expect(page.getByTestId('recording-status')).toContainText('Recording')
  })

  await test.step('pause holds the timer; resume carries on', async () => {
    // Relative to wherever the timer is: CI machines get here at different times.
    await page.getByTestId('clip-pause').click()
    const paused = await page.getByTestId('recording-timer').textContent()
    await page.waitForTimeout(1500)
    await expect(page.getByTestId('recording-timer')).toHaveText(paused ?? '')
    await page.getByTestId('clip-pause').click()
    await expect
      .poll(async () => seconds(await page.getByTestId('recording-timer').textContent()), {
        timeout: 6_000,
      })
      .toBeGreaterThanOrEqual(seconds(paused) + 2)
  })

  await test.step('Stop in the bubble saves and opens the clip', async () => {
    const pip = context.pages().find((p) => p !== page)
    if (!pip) throw new Error('the bubble window is gone')
    recordedSeconds = seconds(await page.getByTestId('recording-timer').textContent())
    await pip.getByTestId('bubble-stop').click()
    await page.waitForURL(/\/clips\/[0-9A-Z]{26}$/, { timeout: 15_000 })
    clipId = page.url().split('/').pop() ?? ''
    await expect.poll(() => context.pages().length).toBe(1)
  })

  await test.step('the camera goes into the video as a round bubble at the bottom left', async () => {
    // The screen alone plays first; the page switches to the camera version when it's ready.
    await expect(video(page)).toHaveAttribute('src', /composite/, { timeout: 30_000 })
    await expect(page.getByTestId('composite-status')).toHaveCount(0)
    const composite = clipFile(clipId, 'composite.mp4')
    const screen = ['video.mp4', 'video.webm'].map((n) => clipFile(clipId, n)).find(existsSync)
    if (!screen) throw new Error('no screen video on disk')
    expect(
      existsSync(clipFile(clipId, 'camera.webm')) || existsSync(clipFile(clipId, 'camera.mp4')),
    ).toBe(true)
    // Where the bubble's ring is (server bubbleGeometry: 24% of the height, 3.5% margin).
    const h = await videoHeight(composite)
    const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
    const size = even(h * 0.24)
    const margin = even(h * 0.035)
    const ring = even(Math.max(2, h * 0.006))
    const cx = margin + size / 2
    const ringY = h - margin - size - Math.floor(ring / 2)
    const inComposite = await pixel(composite, 2, cx, ringY)
    const onScreen = await pixel(screen, 2, cx, (ringY * (await videoHeight(screen))) / h)
    // The ring is Hearth's paper colour; the screen there isn't.
    expect(inComposite[0]).toBeGreaterThan(200)
    expect(inComposite[1]).toBeGreaterThan(195)
    expect(inComposite[2]).toBeGreaterThan(185)
    expect(onScreen).not.toEqual(inComposite)
  })

  await test.step('the video plays and seeks, with the right duration', async () => {
    await expect(video(page)).toBeVisible({ timeout: 20_000 })
    await expect
      .poll(async () => (await videoState(page)).readyState, { timeout: 10_000 })
      .toBeGreaterThan(0)
    const { duration, seekableEnd } = await videoState(page)
    // What the timer showed at Stop (it counts recorded time only, so the pause isn't in it).
    expect(duration).toBeGreaterThan(recordedSeconds - 1.5)
    expect(duration).toBeLessThan(recordedSeconds + 2)
    expect(Number.isFinite(duration)).toBe(true)
    expect(seekableEnd).toBeGreaterThan(duration - 0.5)
    const whole = Math.floor(duration)
    await expect(page.getByTestId('clip-meta')).toContainText(
      `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`,
    )

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

    // m mutes and unmutes; f goes full screen and back.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    const muted = () => video(page).evaluate((el: HTMLVideoElement) => el.muted)
    await page.keyboard.press('m')
    await expect.poll(muted).toBe(false)
    await page.keyboard.press('m')
    await expect.poll(muted).toBe(true)
    const full = () => page.evaluate(() => document.fullscreenElement?.tagName ?? null)
    await page.keyboard.press('f')
    await expect.poll(full).toBe('VIDEO')
    await page.keyboard.press('f')
    await expect.poll(full).toBe(null)
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

  await test.step('speakers: two found, the owner names one, every line follows', async () => {
    await expect(page.getByTestId('speaker-0')).toHaveText('Speaker 1')
    await expect(page.getByTestId('speaker-1')).toHaveText('Speaker 2')
    await expect(page.getByTestId('transcript-speaker').first()).toHaveText('Speaker 1')
    await page.getByTestId('speaker-0').click()
    await page.getByTestId('speaker-input-0').fill('Alex')
    await page.getByTestId('speaker-input-0').press('Enter')
    await expect(page.getByTestId('speaker-0')).toHaveText('Alex')
    // The fake transcript alternates speakers 0 and 1, a line per two seconds of the clip, so
    // its length follows how long the recording ran: odd lines are speaker 0.
    const lines = page.getByTestId('transcript-speaker')
    const count = await lines.count()
    expect(count).toBeGreaterThanOrEqual(3)
    await expect(lines).toHaveText(
      Array.from({ length: count }, (_, i) => (i % 2 === 0 ? 'Alex' : 'Speaker 2')),
    )
  })

  await test.step('Summarize and Action items, then send it all to a new doc', async () => {
    await page.getByTestId('clip-summarize').click()
    await expect(page.getByTestId('clip-ai-summary')).toContainText('A fake clip that opens with')
    await page.getByTestId('clip-actions').click()
    const actions = page.getByTestId('clip-ai-actions')
    await expect(actions).toContainText('Follow up on the first point')
    await expect(actions.locator('input[type="checkbox"]')).toHaveCount(2)
    await page.getByTestId('clip-send-doc').click()
    const open = page.getByTestId('clip-sent').getByRole('link')
    await expect(open).toHaveText('Open the doc')
    await open.click()
    await expect(page).toHaveURL(/\/docs\/[^/]+\/docs\/clips\/about-clip-segment-1\.md$/)
    await expect(page.getByText('Watch the clip')).toBeVisible()
    await expect(page.getByText('Follow up on the first point')).toBeVisible()
    await page.goBack()
    await expect(video(page)).toBeVisible()
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
