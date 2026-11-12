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
  page,
  playwright,
  baseURL,
}) => {
  await page.goto('/docs')
  await page.getByTestId('app-switch-dictate').click()
  await expect(page).toHaveURL(/\/dictate$/)
  await expect(page.getByRole('heading', { name: 'Talk anywhere you can type.' })).toBeVisible()
  // This server was built without the Mac app (only the Docker image copies it in), so the
  // page points to the source instead of a download that isn't there.
  await expect(page.getByTestId('dictate-build-from-source')).toBeVisible()
  await expect(page.getByTestId('dictate-download')).toHaveCount(0)
  await expect(page.getByTestId('dictate-words-team')).toContainText('Hotsauce')

  await page.getByTestId('dictate-connect').click()
  const code = (await page.getByTestId('dictate-connect-code').textContent()) ?? ''
  const link = new URL(code)
  expect(link.protocol).toBe('hearth-dictate:')
  expect(link.searchParams.get('server')).toBe(new URL(baseURL ?? '').origin)
  const token = link.searchParams.get('token') ?? ''
  expect(token).toMatch(/^hdt_/)
  await expect(page.getByTestId('dictate-devices')).toContainText('Mac connected')

  await page.getByRole('textbox', { name: 'Add to my words' }).fill(`Zorblax${Date.now()}`)
  await page.getByTestId('dictate-words-mine').getByRole('button', { name: 'Add' }).click()
  await expect(page.getByTestId('dictate-words-mine')).toContainText('Zorblax')

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
  expect(words.mine[0]).toMatch(/^Zorblax/)
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
