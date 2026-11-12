import type { Page } from '@playwright/test'
import { uid } from './fixtures'
import { expect, type Member, test } from './meetings-fixtures'

// Hearth Notes (ARCHITECTURE §14), against the built server. Each test gets a fresh member; team
// notes are shared by every worker, so titles carry a unique id.

interface NoteView {
  space: string
  id: string
  title: string
  body: string
  checklist: boolean
  color: string | null
  pinned: boolean
  archived: boolean
  trashed: string | null
  labels: string[]
}

async function notes(member: Member, view = 'board'): Promise<NoteView[]> {
  const res = await member.request.get('/api/notes', { params: { view } })
  expect(res.ok(), await res.text()).toBe(true)
  return ((await res.json()) as { notes: NoteView[] }).notes
}

const card = (page: Page, text: string) => page.getByTestId('note-card').filter({ hasText: text })

test('take a note and a checklist, edit, color, pin and label them, and they survive a reload', async ({
  page,
  member,
}) => {
  const id = uid()
  await page.goto('/notes')
  await expect(page.getByTestId('notes-title')).toHaveText('Notes')

  await page.getByTestId('notes-take-note').click()
  await page.getByTestId('composer-title').fill(`Plumber ${id}`)
  await page.getByTestId('composer-body').fill('Call about the sink')
  await page.getByTestId('composer-close').click()
  await expect(card(page, `Plumber ${id}`)).toBeVisible()

  await page.getByTestId('notes-new-list').click()
  await page.getByTestId('checklist-new').pressSequentially(`Milk ${id}`)
  await page.keyboard.press('Enter')
  await page.keyboard.type('Bread')
  await page.keyboard.press('Escape')
  await expect(card(page, `Milk ${id}`)).toBeVisible()
  const list = (await notes(member)).find((n) => n.body.includes(`Milk ${id}`))
  expect(list).toMatchObject({ checklist: true, body: `- [ ] Milk ${id}\n- [ ] Bread` })

  // Tick from the card.
  await card(page, `Milk ${id}`).getByRole('checkbox', { name: 'Tick Bread' }).click()
  await expect
    .poll(async () => (await notes(member)).find((n) => n.id === list?.id)?.body)
    .toBe(`- [ ] Milk ${id}\n- [x] Bread`)

  // Open, type, color, pin and label.
  await card(page, `Plumber ${id}`).getByTestId('note-card-open').click()
  const editor = page.getByTestId('note-editor')
  await expect(editor).toBeVisible()
  await editor.getByTestId('note-editor-body').press('End')
  await editor.getByTestId('note-editor-body').pressSequentially(' today')
  await editor.getByTestId('note-color').click()
  await editor.getByTestId('note-color-teal').click()
  await editor.getByTestId('note-editor-pin').click()
  await editor.getByTestId('note-labels').click()
  await editor.getByTestId('note-label-input').fill(`Home${id}`)
  await editor.getByTestId('note-label-input').press('Enter')
  await expect(editor.getByText(`Home${id}`).first()).toBeVisible()
  await page.keyboard.press('Escape') // closes the label popover
  await editor.getByTestId('note-editor-close').click()
  await expect(editor).toBeHidden()

  await page.reload()
  const plumber = card(page, `Plumber ${id}`)
  await expect(plumber).toBeVisible()
  await expect(plumber).toHaveAttribute('data-color', 'teal')
  await expect(plumber).toContainText('Call about the sink today')
  await expect(page.getByRole('region', { name: 'Pinned' })).toContainText(`Plumber ${id}`)

  // The label is in the sidebar and filters the board.
  await page.getByRole('link', { name: new RegExp(`Home${id}`) }).click()
  await expect(page.getByTestId('notes-title')).toHaveText(`Home${id}`)
  await expect(page.getByTestId('note-card')).toHaveCount(1)
})

test('archive, trash, restore and delete forever', async ({ page, member }) => {
  const id = uid()
  const res = await member.request.post('/api/notes', { data: { title: `Old ${id}`, body: 'x' } })
  expect(res.status()).toBe(201)
  await page.goto('/notes')
  await card(page, `Old ${id}`).hover()
  await card(page, `Old ${id}`).getByTestId('note-card-archive').click()
  await expect(card(page, `Old ${id}`)).toHaveCount(0)
  await page.getByTestId('notes-nav-archive').click()
  await expect(card(page, `Old ${id}`)).toBeVisible()
  await card(page, `Old ${id}`).hover()
  await card(page, `Old ${id}`).getByTestId('note-card-trash').click()
  await page.getByTestId('notes-nav-trash').click()
  await expect(card(page, `Old ${id}`)).toContainText('Deleted for good in 30 days')
  await card(page, `Old ${id}`).hover()
  await card(page, `Old ${id}`).getByTestId('note-card-restore').click()
  await expect(card(page, `Old ${id}`)).toHaveCount(0)
  // A restored note goes back where it was: the archive.
  await expect
    .poll(async () => (await notes(member, 'archive')).map((n) => n.title))
    .toEqual([`Old ${id}`])

  const again = (await notes(member, 'archive'))[0] as NoteView
  await member.request.post(`/api/notes/${again.space}/${again.id}/trash`)
  await page.reload()
  await card(page, `Old ${id}`).hover()
  await card(page, `Old ${id}`).getByTestId('note-card-delete').click()
  await page.getByTestId('note-delete-confirm').click()
  await expect(page.getByTestId('notes-empty')).toBeVisible()
  await expect
    .poll(async () => (await member.request.get(`/api/notes/${again.space}/${again.id}`)).status())
    .toBe(404)
})

test('a note moved to Team is visible to a teammate; a personal one is not', async ({
  page,
  member,
  newMember,
}) => {
  const id = uid()
  const other = await newMember()
  await member.request.post('/api/notes', { data: { title: `Private ${id}` } })
  await member.request.post('/api/notes', { data: { title: `Shared ${id}`, body: 'hello' } })
  await page.goto('/notes')
  await card(page, `Shared ${id}`).getByTestId('note-card-open').click()
  await page.getByTestId('note-move-team').click()
  await expect(page.getByTestId('notes-toast')).toContainText('Moved to Team')
  await page.getByTestId('note-editor-close').click()
  await expect(card(page, `Shared ${id}`)).toContainText('Team')

  const theirs = (await notes(other)).map((n) => n.title)
  expect(theirs).toContain(`Shared ${id}`)
  expect(theirs).not.toContain(`Private ${id}`)
})

test('a checklist line becomes a Hearth task', async ({ page, member }) => {
  const id = uid()
  await member.request.post('/api/notes', {
    data: { title: `Errands ${id}`, body: `- [ ] Post the forms ${id}` },
  })
  await page.goto('/notes')
  await card(page, `Errands ${id}`).getByTestId('note-card-open').click()
  const editor = page.getByTestId('note-editor')
  await editor.getByRole('button', { name: `Make a task: Post the forms ${id}` }).click()
  await expect(page.getByTestId('notes-toast')).toContainText('to Tasks')
  const res = await member.request.get('/api/tasks', { params: { status: 'all' } })
  const tasks = ((await res.json()) as { tasks: Array<{ title: string; space: string }> }).tasks
  expect(tasks).toContainEqual(
    expect.objectContaining({ title: `Post the forms ${id}`, space: member.personal }),
  )
})

test('imports a Google Takeout zip, and a second import adds nothing', async ({ page, member }) => {
  const id = uid()
  const zip = await keepZip([
    {
      name: 'Takeout/Keep/Groceries.json',
      json: {
        title: `Keep groceries ${id}`,
        listContent: [{ text: 'milk', isChecked: false }],
        color: 'YELLOW',
        isPinned: true,
        labels: [{ name: 'Home' }],
        createdTimestampUsec: 1_700_000_000_000_000,
      },
    },
    { name: 'Takeout/Keep/Idea.json', json: { textContent: `A thought ${id}`, isArchived: true } },
    { name: 'Takeout/Keep/Gone.json', json: { textContent: 'deleted', isTrashed: true } },
    { name: 'Takeout/Keep/photo.png', raw: 'not a note' },
  ])
  await page.goto('/notes/import')
  await expect(page.getByTestId('keep-takeout-link')).toHaveAttribute(
    'href',
    'https://takeout.google.com/settings/takeout/custom/keep',
  )
  await page.getByTestId('keep-file').setInputFiles({
    name: 'takeout.zip',
    mimeType: 'application/zip',
    buffer: zip,
  })
  await expect(page.getByTestId('keep-result')).toContainText('Imported 2 notes')
  const board = await notes(member)
  expect(board.find((n) => n.title === `Keep groceries ${id}`)).toMatchObject({
    body: '- [ ] milk',
    color: 'yellow',
    pinned: true,
    labels: ['Home'],
  })
  expect((await notes(member, 'archive')).map((n) => n.body)).toEqual([`A thought ${id}`])

  await page.getByTestId('keep-file').setInputFiles({
    name: 'takeout.zip',
    mimeType: 'application/zip',
    buffer: zip,
  })
  await expect(page.getByTestId('keep-result')).toContainText('Imported 0 notes')
})

/** A Takeout-shaped zip, deflated like Google's. */
async function keepZip(
  files: Array<{ name: string; json?: unknown; raw?: string }>,
): Promise<Buffer> {
  const { deflateRawSync } = await import('node:zlib')
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name)
    const raw = Buffer.from(f.raw ?? JSON.stringify(f.json))
    const data = deflateRawSync(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, data)
    centrals.push(central, name)
    offset += 30 + name.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}
