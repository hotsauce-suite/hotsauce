import { docUrl, expect, test, uid } from './fixtures'

// The built-in assistant (docs/PLAN-assistant.md) with the dev stand-in model, which searches
// for the question's two longest words and answers with links, adds a task for "add a task …",
// and proposes delete_file for "delete <space>/<path>".

test('⌘J opens the assistant on a doc with the doc attached, and it answers with a link', async ({
  page,
  api,
  user,
}) => {
  const word = `kestrel${uid()}`
  const file = `docs/assistant-${word}.md`
  await api.writeFile(user.team, file, `# Kestrel notes\n\nThe ${word} rollout starts in May.\n`)
  await page.goto(docUrl(user.team, file))
  await expect(page.getByText('rollout starts in May')).toBeVisible()

  await page.keyboard.press('ControlOrMeta+j')
  const panel = page.getByTestId('assistant-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('heading', { name: /^Ask / })).toBeVisible()
  await expect(panel.getByTestId('assistant-context')).toContainText(`assistant-${word}`)

  // The index takes the commit just after it lands; ask until the search finds it.
  await expect(async () => {
    await panel.getByRole('button', { name: 'New conversation' }).click()
    await panel.getByTestId('assistant-input').fill(`Where is the ${word} rollout?`)
    await panel.getByTestId('assistant-input').press('Enter')
    await expect(panel.getByTestId('assistant-answer').last().getByRole('link')).toBeVisible({
      timeout: 3000,
    })
  }).toPass({ timeout: 20_000 })
  await expect(panel.getByTestId('assistant-tool').first()).toContainText('Searched')

  // The page chip comes off, and the conversation is in the history.
  await panel.getByRole('button', { name: "Don't include this page" }).click()
  await expect(panel.getByTestId('assistant-context')).toHaveCount(0)
  await panel.getByRole('button', { name: 'Past conversations' }).click()
  await expect(panel.getByTestId('assistant-history')).toContainText(word)
  await panel.getByRole('button', { name: 'Past conversations' }).click()

  await panel.getByTestId('assistant-answer').last().getByRole('link').first().click()
  await expect(page).toHaveURL((url) => url.pathname === docUrl(user.team, file))

  await page.keyboard.press('ControlOrMeta+j')
  await expect(panel).toBeHidden()
  await page.getByTestId('assistant-open').click()
  await expect(panel).toBeVisible()
})

test('an added task offers Undo, and a delete waits for Confirm', async ({ page, api, user }) => {
  const id = uid()
  await page.goto('/tasks')
  await page.getByTestId('assistant-open').click()
  const panel = page.getByTestId('assistant-panel')

  await panel.getByTestId('assistant-input').fill(`add a task Water the ficus ${id}`)
  await panel.getByTestId('assistant-send').click()
  const tool = panel.getByTestId('assistant-tool').first()
  await expect(tool).toHaveAttribute('data-status', 'done')
  await expect(tool).toContainText('Added a task')
  await tool.getByRole('button', { name: 'Undo' }).click()
  await expect(tool).toHaveAttribute('data-status', 'undone')

  const file = `docs/scratch-${id}.md`
  await api.writeFile(user.team, file, '# Scratch\n')
  await panel.getByRole('button', { name: 'New conversation' }).click()
  await panel.getByTestId('assistant-input').fill(`delete ${user.team}/${file}`)
  await panel.getByTestId('assistant-send').click()
  await expect(panel.getByTestId('assistant-confirm')).toBeVisible()
  expect(await api.readFile(user.team, file)).not.toBeNull()
  await panel.getByTestId('assistant-confirm').click()
  await expect(panel.getByTestId('assistant-tool').first()).toHaveAttribute(
    'data-status',
    'confirmed',
  )
  expect(await api.readFile(user.team, file)).toBeNull()
})
