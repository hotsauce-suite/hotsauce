import { signIn, uid } from './fixtures'
import { expect, getSession, meSegment, startMicOnly, test } from './meetings-fixtures'

test("another member can't reach someone's live meeting", async ({
  page,
  member,
  newMember,
  browser,
  baseURL,
}) => {
  await page.goto('/meetings/start')
  const title = `Private call ${uid()}`
  await page.getByTestId('start-title').fill(title)
  const id = await startMicOnly(page)
  await expect(meSegment(page).first()).toBeVisible({ timeout: 5_000 })

  // Every session route is the owner's alone: 403, and nothing changes.
  const other = await newMember()
  const session = `/api/meetings/sessions/${encodeURIComponent(id)}`
  const refused = [
    await other.request.get(session),
    await other.request.put(`${session}/notes`, { data: { text: 'not mine' } }),
    await other.request.post(`${session}/pause`, { data: {} }),
    await other.request.post(`${session}/stop`, { data: {} }),
  ]
  expect(refused.map((r) => r.status())).toEqual([403, 403, 403, 403])
  const owners = await getSession(member, id)
  expect(owners.state).toBe('recording')
  expect(owners.rawNotes).not.toContain('not mine')

  // Their browser gets an error page, not the recording UI.
  const context = await browser.newContext(baseURL ? { baseURL } : {})
  try {
    const theirs = await context.newPage()
    await signIn(theirs, other.email)
    const lookup = theirs.waitForResponse((r) => new URL(r.url()).pathname === session)
    await theirs.goto(`/meetings/live/${encodeURIComponent(id)}`)
    expect((await lookup).status()).toBe(403)
    // The page says it can't open the meeting; it doesn't show the meeting's title.
    await expect(theirs.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(theirs.getByText(title)).toHaveCount(0)
    await expect(theirs.getByTestId('recording-indicator')).toHaveCount(0)
    await expect(theirs.getByTestId('live-notepad')).toHaveCount(0)
    await expect(theirs.getByTestId('stop')).toHaveCount(0)
  } finally {
    await context.close()
  }

  // The owner's meeting carried on throughout.
  expect((await getSession(member, id)).state).toBe('recording')
  await expect(page.getByTestId('recording-indicator')).toHaveAttribute('data-state', 'recording')
})
