import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures'

// The trim editor (ARCHITECTURE §10.6) against the built server: a 10 s clip uploaded the way
// the recorder does it, then trimmed in the page with the mouse and saved; FakeClipTranscriber
// gives about one line per two seconds, so the transcript shows what was cut.

const run = promisify(execFile)

function clipFile(id: string, name: string): string {
  return path.join(process.env.HOTSAUCE_E2E_DATA_DIR ?? '', 'kept-audio', 'clips', id, name)
}

async function probeSeconds(file: string): Promise<number> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    file,
  ])
  return Number(stdout.trim())
}

/** The x on `track` for `seconds` into a `total`-second video. */
async function xAt(track: Locator, seconds: number, total: number): Promise<number> {
  const box = await track.boundingBox()
  if (!box) throw new Error('no timeline')
  return box.x + (box.width * seconds) / total
}

async function dragOnTrack(page: Page, track: Locator, from: number, to: number, total: number) {
  const box = await track.boundingBox()
  if (!box) throw new Error('no timeline')
  const y = box.y + box.height / 2
  await page.mouse.move(await xAt(track, from, total), y)
  await page.mouse.down()
  await page.mouse.move(await xAt(track, (from + to) / 2, total), y, { steps: 4 })
  await page.mouse.move(await xAt(track, to, total), y, { steps: 4 })
  await page.mouse.up()
}

test('trim the start, the end and a part in the middle, save, then restore the original', async ({
  page,
  user,
  playwright,
  baseURL,
}) => {
  test.setTimeout(120_000)
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hotsauce-trim-'))
  const file = path.join(dir, 'clip.webm')
  await run('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    ...['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15:duration=10'],
    ...['-f', 'lavfi', '-i', 'sine=frequency=330:duration=10'],
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
  expect(
    (
      await owner.put(`/api/clips/${clip.id}/chunks/0`, {
        data: bytes,
        headers: { 'content-type': 'application/octet-stream' },
      })
    ).status(),
  ).toBe(204)
  expect((await owner.post(`/api/clips/${clip.id}/finish`, { data: { chunks: 1 } })).ok()).toBe(
    true,
  )

  await page.goto(`/clips/${clip.id}`)
  const lines = page.getByTestId('transcript-line')
  await expect(lines.first()).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => lines.count()).toBeGreaterThanOrEqual(5)
  const before = await lines.count()
  const total = (await (await owner.get(`/api/clips/${clip.id}`)).json()).clip.durationMs / 1000

  const editor = page.getByTestId('clip-trim-editor')
  const track = page.getByTestId('trim-track')
  const length = page.getByTestId('trim-length')

  await test.step('Trim opens the editor on the whole recording, with frames on the timeline', async () => {
    await page.getByTestId('clip-trim').click()
    await expect(editor).toBeVisible()
    await expect(page.getByTestId('clip-video')).toBeHidden()
    await expect(length).toHaveText('0:10')
    await expect
      .poll(() => track.locator('canvas[data-drawn="true"]').count(), { timeout: 15_000 })
      .toBeGreaterThan(3)
  })

  await test.step('drag the start handle in a second, set the end at 9 s', async () => {
    const handle = page.getByTestId('trim-handle-start')
    const hb = await handle.boundingBox()
    if (!hb) throw new Error('no handle')
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
    await page.mouse.down()
    await page.mouse.move(await xAt(track, 1, total), hb.y + hb.height / 2, { steps: 6 })
    await page.mouse.up()
    await expect(handle).toHaveAttribute('aria-valuenow', '1')
    // A click on the timeline moves the playhead; End here trims there.
    const box = await track.boundingBox()
    if (!box) throw new Error('no timeline')
    await page.mouse.click(await xAt(track, 9, total), box.y + box.height / 2)
    await expect(page.getByTestId('trim-time')).toContainText('0:09')
    await page.getByTestId('trim-end-here').click()
    await expect(page.getByTestId('trim-handle-end')).toHaveAttribute('aria-valuenow', '9')
    await expect(length).toHaveText('0:08')
  })

  await test.step('select 4–6 s on the timeline and cut it out', async () => {
    await dragOnTrack(page, track, 4, 6, total)
    await expect(page.getByTestId('trim-selection')).toBeVisible()
    await expect(page.getByTestId('trim-cut-selection')).toHaveText(/Cut 0:0[12]/)
    await page.getByTestId('trim-cut-selection').click()
    await expect(page.getByTestId('trim-cut')).toHaveCount(1)
    await expect(length).toHaveText(/0:0[56]/)
    // Undo puts it back, and so does the × on the cut; then cut it again.
    await page.getByTestId('trim-undo').click()
    await expect(page.getByTestId('trim-cut')).toHaveCount(0)
    await dragOnTrack(page, track, 4, 6, total)
    await page.getByTestId('trim-cut-selection').click()
    await expect(page.getByTestId('trim-cut')).toHaveCount(1)
  })

  await test.step('preview skips what is cut', async () => {
    const trimVideo = page.getByTestId('trim-video')
    await trimVideo.evaluate((el: HTMLVideoElement) => {
      el.muted = true
      el.currentTime = 3.6
    })
    await page.getByTestId('trim-play').click()
    // Played across 4–6 s without ever showing it.
    const seen = await trimVideo.evaluate(
      (el: HTMLVideoElement) =>
        new Promise<number[]>((resolve) => {
          const times: number[] = []
          const timer = setInterval(() => times.push(el.currentTime), 30)
          setTimeout(() => {
            clearInterval(timer)
            el.pause()
            resolve(times)
          }, 1500)
        }),
    )
    expect(Math.max(...seen)).toBeGreaterThan(6)
    expect(seen.filter((t) => t > 4.15 && t < 5.9)).toEqual([])
  })

  const cuts =
    await test.step('save: the trimmed video plays, with the transcript moved', async () => {
      await page.getByTestId('trim-save').click()
      await expect(editor).toBeHidden()
      const v = page.getByTestId('clip-video')
      await expect(v).toHaveAttribute('src', /edited/, { timeout: 30_000 })
      await expect(page.getByTestId('trim-note')).toContainText('Trimmed from 0:10')
      await expect
        .poll(() => v.evaluate((el: HTMLVideoElement) => el.duration), { timeout: 10_000 })
        .toBeGreaterThan(5)
      const duration = await v.evaluate((el: HTMLVideoElement) => el.duration)
      const saved = (await (await owner.get(`/api/clips/${clip.id}`)).json()).clip
      const kept =
        (saved.sourceDurationMs -
          saved.cuts.reduce(
            (sum: number, c: { startMs: number; endMs: number }) => sum + c.endMs - c.startMs,
            0,
          )) /
        1000
      expect(duration).toBeGreaterThan(kept - 0.4)
      expect(duration).toBeLessThan(kept + 0.4)
      expect(await probeSeconds(clipFile(clip.id, 'edited-1.mp4'))).toBeCloseTo(kept, 0)
      // The 0–2 s line lost its first second; the 4–6 s lines are gone or moved earlier.
      await expect(lines.first()).toContainText('0:00')
      expect(await lines.count()).toBeLessThan(before)
      await expect(page.getByTestId('clip-meta')).toContainText(
        `0:0${Math.floor(saved.durationMs / 1000)}`,
      )
      return saved.cuts as Array<{ startMs: number; endMs: number }>
    })

  await test.step('another member watches the trim and gets no Trim button', async () => {
    const other = await playwright.request.newContext({
      baseURL: baseURL as string,
      extraHTTPHeaders: { 'x-hearth-dev-user': `viewer-${Date.now()}@example.test` },
    })
    const seen = (await (await other.get(`/api/clips/${clip.id}`)).json()).clip
    expect(seen.edited).toBe(true)
    expect(seen.sourceUrl).toBeNull()
    expect(seen.cuts).toEqual([])
    expect((await other.put(`/api/clips/${clip.id}/edit`, { data: { cuts } })).status()).toBe(403)
    await other.dispose()
  })

  await test.step('reopen the editor with the cuts, then restore the original', async () => {
    await page.getByTestId('clip-trim').click()
    await expect(page.getByTestId('trim-cut')).toHaveCount(1)
    await expect(page.getByTestId('trim-handle-start')).toHaveAttribute('aria-valuenow', '1')
    await page.getByTestId('trim-revert').click()
    await expect(editor).toBeHidden()
    const v = page.getByTestId('clip-video')
    await expect(v).not.toHaveAttribute('src', /edited/)
    await expect(lines).toHaveCount(before)
    await expect(page.getByTestId('trim-note')).toHaveCount(0)
    expect(existsSync(clipFile(clip.id, 'edited-1.mp4'))).toBe(false)
  })

  await owner.delete(`/api/clips/${clip.id}`)
  await owner.dispose()
})
