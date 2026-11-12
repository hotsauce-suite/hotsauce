import {
  expect,
  getSession,
  liveSessionId,
  parseMeetingUrl,
  test,
  transcriptPath,
} from './meetings-fixtures'

// docs/PLAN-record-any-call.md requirement 6: "Any app on this Mac" end to end, with a stand-in
// for the Hearth Mac app's bridge. It answers start like the app and sends 100 ms frames of a
// tone on both tracks, as the app does from the mic and the Mac's audio.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>
    const calls: unknown[] = []
    let timer: ReturnType<typeof setInterval> | null = null
    const frame = (() => {
      const bytes = new Uint8Array(3200)
      const view = new DataView(bytes.buffer)
      for (let i = 0; i < 1600; i++) {
        view.setInt16(i * 2, Math.round(Math.sin(i / 4) * 8000), true)
      }
      return btoa(String.fromCharCode(...bytes))
    })()
    w.__macCalls = calls
    w.hearthMac = { meetingAudio: 1 }
    w.webkit = {
      messageHandlers: {
        hearthMeetingAudio: {
          postMessage: async (message: { type: string; session?: string }) => {
            calls.push(message)
            if (message.type === 'start') {
              if (timer) clearInterval(timer)
              timer = setInterval(() => {
                window.dispatchEvent(
                  new CustomEvent('hearth-mac-audio', {
                    detail: { session: 'mac-1', type: 'frames', me: frame, them: frame },
                  }),
                )
              }, 100)
              return { ok: true, session: 'mac-1' }
            }
            if (message.type === 'stop' && timer) {
              clearInterval(timer)
              timer = null
            }
            return null
          },
        },
      },
    }
  })
})

test('any app on this Mac: both tracks are transcribed and saved, and the app is told to stop', async ({
  page,
  member,
}) => {
  await page.goto('/meetings/start')
  await page.getByTestId('start-title').fill('Zoom with Acme')
  await page.getByTestId('capture-mac').click()
  await expect(page.getByTestId('audio-check')).toHaveAttribute('data-state', 'ok', {
    timeout: 5_000,
  })
  await page.getByTestId('start-recording').click()
  await page.waitForURL(/\/meetings\/live\/[^/]+$/)
  const id = liveSessionId(page)

  // The live transcript shows the newest line; the server has them all.
  await expect
    .poll(async () => (await getSession(member, id)).segments.map((s) => s.text), {
      timeout: 8_000,
    })
    .toEqual(expect.arrayContaining(['me segment 1', 'them segment 1']))

  await page.getByTestId('stop').click()
  await page.waitForURL((url) => /\/meetings\/[^/]+\/meetings\/.+\.md$/.test(url.pathname), {
    timeout: 10_000,
  })
  const note = parseMeetingUrl(page.url())
  const transcript = await member.api.readFile(note.space, transcriptPath(note.path))
  expect(transcript?.content).toContain('**Me:** me segment 1')
  expect(transcript?.content).toContain('**Them:** them segment 1')

  const calls = await page.evaluate(
    () => (window as unknown as { __macCalls: unknown[] }).__macCalls,
  )
  expect(calls).toContainEqual({ type: 'start' })
  expect(calls).toContainEqual({ type: 'stop', session: 'mac-1' })
})

test('from the call notice, recording starts listening at once, and the call ending stops it', async ({
  page,
  member: _member,
}) => {
  await page.goto('/meetings/start?via=mac-call&app=Zoom')
  await expect(page.getByTestId('start-title')).toHaveValue('Zoom call')
  await expect(page.getByTestId('audio-check')).toHaveAttribute('data-state', 'ok', {
    timeout: 5_000,
  })
  await page.getByTestId('start-recording').click()
  await page.waitForURL(/\/meetings\/live\/[^/]+$/)

  await expect(page.getByTestId('live-notepad')).toBeVisible()
  await page.clock.install()
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('hearth-mac-audio', { detail: { session: 'mac-1', type: 'call-ended' } }),
    ),
  )
  await expect(page.getByTestId('call-ended')).toContainText('stops taking notes in 30 s')
  await page.clock.runFor(31_000)
  await page.waitForURL((url) => /\/meetings\/[^/]+\/meetings\/.+\.md$/.test(url.pathname), {
    timeout: 10_000,
  })
})
