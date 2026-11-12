import { expect, test } from './fixtures'

/** A 16 kHz mono PCM16 WAV of silence. */
function wav(ms: number): Buffer {
  const data = ms * 32
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data, 4)
  header.write('WAVEfmt ', 8, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data, 40)
  return Buffer.concat([header, Buffer.alloc(data)])
}

test('Dictate: connect this Mac, dictate with its token, words, disconnect', async ({
  page: connectTab,
  playwright,
  baseURL,
}) => {
  await connectTab.goto('/docs')
  await connectTab.getByTestId('app-switch-dictate').click()
  await expect(connectTab).toHaveURL(/\/dictate$/)
  await expect(
    connectTab.getByRole('heading', { name: 'Talk anywhere you can type.' }),
  ).toBeVisible()
  // This server was built without the Mac app (only the Docker image copies it in), so the
  // page points to the source instead of a download that isn't there.
  await expect(connectTab.getByTestId('dictate-build-from-source')).toBeVisible()
  await expect(connectTab.getByTestId('dictate-download')).toHaveCount(0)
  await expect(connectTab.getByTestId('dictate-words-team')).toContainText('Hotsauce')

  await connectTab.getByTestId('dictate-connect').click()
  const code = (await connectTab.getByTestId('dictate-connect-code').textContent()) ?? ''
  const link = new URL(code)
  expect(link.protocol).toBe('hearth-dictate:')
  expect(link.searchParams.get('server')).toBe(new URL(baseURL ?? '').origin)
  const token = link.searchParams.get('token') ?? ''
  expect(token).toMatch(/^hdt_/)
  await expect(connectTab.getByTestId('dictate-devices')).toContainText('Mac connected')

  // Connecting hands the link to the Mac app, and newer Chrome holds that tab behind its own
  // prompt to open the app, which a test can't answer (a reload doesn't clear it). Carry on in a
  // new tab, signed in the same way: what a person has once they answer the prompt.
  const page = await connectTab.context().newPage()
  await connectTab.close()
  await page.goto('/dictate')
  const mine = page.getByTestId('dictate-words-mine')
  const word = `Zorblax${Date.now()}`
  await page.getByRole('textbox', { name: 'Add to my words' }).fill(word)
  await mine.getByRole('button', { name: 'Add' }).click()
  await expect(mine).toContainText(word)
  await page.reload()
  await expect(mine).toContainText(word)

  // The Mac app's side: only the token, no session.
  const mac = await playwright.request.newContext({
    ...(baseURL ? { baseURL } : {}),
    extraHTTPHeaders: { authorization: `Bearer ${token}` },
  })
  const dictated = await mac.post('/api/dictation/transcribe?mode=clean&app_name=Slack', {
    headers: { 'content-type': 'audio/wav' },
    data: wav(1200),
  })
  expect(dictated.status()).toBe(200)
  expect(await dictated.json()).toMatchObject({ cleaned: true, durationMs: 1200 })
  const words = await (await mac.get('/api/dictation/words')).json()
  expect(words.mine[0]).toBe(word)
  expect((await mac.get('/api/me')).status()).toBe(401)

  await page.reload()
  await expect(page.getByTestId('dictate-devices')).toContainText('Last used')
  await page.getByRole('button', { name: /Disconnect Mac connected/ }).click()
  await expect(page.getByTestId('dictate-no-devices')).toBeVisible()
  const after = await mac.post('/api/dictation/transcribe', {
    headers: { 'content-type': 'audio/wav' },
    data: wav(500),
  })
  expect(after.status()).toBe(401)
  await mac.dispose()
})

test('Dictate on a computer: the Mac page links to recording a voice note here', async ({
  page,
}) => {
  await page.goto('/dictate')
  await expect(page.getByRole('heading', { name: 'Talk anywhere you can type.' })).toBeVisible()
  await page.getByTestId('dictate-voice-link').click()
  await expect(page).toHaveURL(/\/dictate\/voice$/)
  await page.getByTestId('voice-record').click()
  await expect(page.getByTestId('voice-recording')).toHaveAttribute('data-state', 'recording', {
    timeout: 5_000,
  })
  await page.getByTestId('voice-stop').click()
  await page.waitForURL((url) => url.pathname.includes('-voice-note.md'), { timeout: 10_000 })
  await expect(page.getByTestId('voice-note-actions')).toBeVisible({ timeout: 10_000 })
  // The home-screen start URL goes to Today on a computer.
  await page.goto('/?launch=home')
  await expect(page).toHaveURL(/\/today$/)
})
