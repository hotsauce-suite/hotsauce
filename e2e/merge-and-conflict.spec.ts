import { docUrl, expect, holdNextSave, replaceLine, test, uid, waitForSave } from './fixtures'

// Each test opens a doc, edits one line in the UI, and holds that save until an
// outside push has changed the same file, so the server sees a stale base and
// must three-way merge (ARCHITECTURE §3.2, commit() step 2).

function docBody(title: string): string {
  return [
    `# ${title}`,
    '',
    'Alpha: original',
    '',
    'The middle paragraph keeps the two edits apart.',
    '',
    'So does this one.',
    '',
    'Omega: original',
    '',
  ].join('\n')
}

test('edits to different paragraphs merge and the UI adopts the result', async ({
  page,
  api,
  user,
  remote,
  waitForState,
}) => {
  const id = uid()
  const file = `docs/e2e-merge-${id}.md`
  await api.writeFile(user.team, file, docBody(`Merge ${id}`))

  await page.goto(docUrl(user.team, file))
  const editor = page.getByTestId('editor-content')
  await expect(editor).toContainText('Omega: original')
  await waitForState('save-state', 'committed')

  const checkout = await remote.clone('team')
  await holdNextSave(page, async () => {
    await checkout.edit(file, (text) => text.replace('Alpha: original', `Alpha: outside ${id}`))
    await checkout.commitAndPush('Edit the first paragraph from outside')
  })

  const saved = waitForSave(page, `Omega: mine ${id}`)
  await replaceLine(page, 'Omega: original', `Omega: mine ${id}`)
  const response = await saved
  expect(response.ok()).toBe(true)
  expect((await response.json()).status).toBe('merged')

  await waitForState('save-state', 'committed', { timeout: 3_000 })
  await expect(editor).toContainText(`Alpha: outside ${id}`)
  await expect(editor).toContainText(`Omega: mine ${id}`)

  await checkout.pull()
  const merged = await checkout.read(file)
  expect(merged).toContain(`Alpha: outside ${id}`)
  expect(merged).toContain(`Omega: mine ${id}`)
})

test('overlapping edits raise a conflict that the resolver settles', async ({
  page,
  api,
  user,
  remote,
  waitForState,
}) => {
  const id = uid()
  const file = `docs/e2e-conflict-${id}.md`
  await api.writeFile(user.team, file, docBody(`Conflict ${id}`))

  await page.goto(docUrl(user.team, file))
  await expect(page.getByTestId('editor-content')).toContainText('Alpha: original')
  await waitForState('save-state', 'committed')

  const checkout = await remote.clone('team')
  await holdNextSave(page, async () => {
    await checkout.edit(file, (text) => text.replace('Alpha: original', `Alpha: theirs ${id}`))
    await checkout.commitAndPush('Edit the first paragraph from outside')
  })

  const saved = waitForSave(page, `Alpha: mine ${id}`)
  await replaceLine(page, 'Alpha: original', `Alpha: mine ${id}`)
  expect((await saved).status()).toBe(409)

  const banner = page.getByTestId('conflict-banner')
  await expect(banner).toBeVisible()
  await waitForState('save-state', 'conflict')
  // Both versions are kept: ours on a conflict branch, theirs on main.
  const conflictPaths = async () => (await api.conflicts(user.team)).map((c) => c.path)
  await expect.poll(conflictPaths).toContain(file)

  const resolver = page.getByTestId('conflict-resolver')
  // The resolver may open on its own after a 409; otherwise the banner opens it.
  if (!(await resolver.isVisible())) await banner.click()
  await expect(resolver).toBeVisible()
  await page.getByTestId('resolve-use-mine').click()
  await page.getByTestId('resolve-save').click()

  await waitForState('save-state', 'committed', { timeout: 3_000 })
  await expect(banner).toHaveCount(0)
  await expect.poll(conflictPaths).not.toContain(file)

  await checkout.pull()
  const resolved = await checkout.read(file)
  expect(resolved).toContain(`Alpha: mine ${id}`)
  expect(resolved).not.toContain(`Alpha: theirs ${id}`)
})
