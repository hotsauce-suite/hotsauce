import { docUrl, expect, signIn, test, uid } from './fixtures'

// Comments and @mentions (docs/PLAN-comments.md ★R1, ★R5, R6): a member comments under a team
// doc and a teammate sees it; an @mention sends the teammate one push, and opening it lands on
// the comment.

test('comment on a team doc, and a teammate sees it', async ({ page, api, user, browser }) => {
  const id = uid()
  const file = `e2e/comments-${id}.md`
  await api.writeFile(
    user.team,
    file,
    `# Comments ${id}\n\nThe budget is flat until the pilots sign.\n`,
  )

  await page.goto(docUrl(user.team, file))
  await expect(page.getByTestId('editor-content')).toContainText('The budget is flat')
  const box = page.getByTestId('comment-input')
  await box.fill(`Looks right to me ${id}`)
  await page.getByTestId('comment-send').click()
  const mine = page.getByTestId('comment').filter({ hasText: `Looks right to me ${id}` })
  await expect(mine).toBeVisible()
  await expect(box).toHaveValue('')
  await expect(page.getByTestId('comments-toggle')).toHaveAccessibleName('Comments (1)')

  // The comment is not part of the doc's text, and it survives a reload.
  await expect(page.getByTestId('editor-content').locator('.cm-line')).not.toContainText([
    `Looks right to me ${id}`,
  ])
  expect((await api.readFile(user.team, file))?.content).not.toContain('Looks right to me')
  await page.reload()
  await expect(mine).toBeVisible()

  // A teammate, in their own browser, reads it and sees a later comment arrive on its own.
  const mate = `e2e-mate-${id}@example.test`
  const context = await browser.newContext()
  const theirs = await context.newPage()
  await signIn(theirs, mate)
  await theirs.goto(docUrl(user.team, file))
  await expect(theirs.getByTestId('comment').filter({ hasText: id })).toBeVisible()
  await expect(theirs.getByTestId('comment-edit')).toHaveCount(0)
  await box.fill(`One more thing ${id}`)
  await page.getByTestId('comment-send').click()
  await expect(
    theirs.getByTestId('comment').filter({ hasText: `One more thing ${id}` }),
  ).toBeVisible()
  await context.close()
})

test('an @mention sends one push, and opening it lands on the comment', async ({
  page,
  api,
  user,
  browser,
  playwright,
  baseURL,
}) => {
  const id = uid()
  const file = `e2e/mention-${id}.md`
  const filler = Array.from({ length: 80 }, (_, i) => `Line ${i + 1} of the plan.`).join('\n\n')
  await api.writeFile(
    user.team,
    file,
    `# Mention ${id}\n\nRevisit the budget in March.\n\n${filler}\n`,
  )

  // The teammate has signed in before, and this device of theirs takes notifications.
  const mate = `e2e-mate-${id}@example.test`
  const mateApi = await playwright.request.newContext({
    ...(baseURL ? { baseURL } : {}),
    extraHTTPHeaders: { 'x-hearth-dev-user': mate },
  })
  const me = (await (await mateApi.get('/api/me')).json()) as {
    principal: { name: string; handle: string }
  }
  const endpoint = `https://fcm.googleapis.com/fcm/send/e2e-comment-${id}`
  const subscribed = await mateApi.post('/api/meetings/reminders', {
    data: { subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } } },
  })
  expect(subscribed.status()).toBe(204)

  // Quote a passage, mention the teammate from the picker, and send.
  await page.goto(docUrl(user.team, file))
  const passage = page.getByTestId('editor-content').getByText('Revisit the budget in March.')
  await passage.click({ clickCount: 3 })
  await page.getByTestId('quote-comment').click()
  await expect(page.getByTestId('comment-quote-draft')).toContainText(
    'Revisit the budget in March.',
  )
  const box = page.getByTestId('comment-input')
  await expect(box).toBeFocused()
  await box.pressSequentially(`@${me.principal.handle}`)
  await page.getByTestId('mention-option').filter({ hasText: me.principal.name }).click()
  await box.pressSequentially(`can you check this? ${id}`)
  await page.getByTestId('comment-send').click()
  const sent = page.getByTestId('comment').filter({ hasText: id })
  await expect(sent.getByTestId('comment-mention')).toBeVisible()
  await expect(sent.getByTestId('comment-quote')).toContainText('Revisit the budget in March.')

  // One push, to the teammate only.
  type Push = { endpoint: string; payload: { title: string; body: string; url: string } }
  let pushes: Push[] = []
  await expect(async () => {
    const all = (await (await mateApi.get('/api/test/pushes')).json()) as Push[]
    pushes = all.filter((p) => p.payload.body.includes(id))
    expect(pushes.length).toBeGreaterThan(0)
  }).toPass({ timeout: 15_000 })
  expect(pushes).toHaveLength(1)
  const push = pushes[0] as Push
  expect(push.endpoint).toBe(endpoint)
  expect(push.payload.title).toContain('mentioned you')
  expect(push.payload.url).toContain('#comment-')

  // Opening it lands on the comment, at the far end of a long doc.
  const context = await browser.newContext()
  const theirs = await context.newPage()
  await signIn(theirs, mate)
  await theirs.goto(push.payload.url)
  const landed = theirs.locator('[data-marked="true"]')
  await expect(landed).toBeInViewport()
  await expect(landed).toContainText(id)
  await context.close()
  await mateApi.dispose()
})
