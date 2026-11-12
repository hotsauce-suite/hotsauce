import type { APIRequestContext, Page } from '@playwright/test'
import { signIn, uid } from './fixtures'
import { expect, test } from './meetings-fixtures'

// Hearth Whiteboard (ARCHITECTURE §15), against the built server: draw, autosave, reload,
// search, embed in a doc, and Excalidraw staying out of every other app's chunks.

interface BoardView {
  space: string
  id: string
  path: string
  title: string
  texts: string[]
  blobOid: string
  scene: { elements: Array<{ id: string; type: string; isDeleted?: boolean }> }
}

async function getBoard(request: APIRequestContext, space: string, id: string): Promise<BoardView> {
  const res = await request.get(`/api/boards/${space}/${id}`)
  expect(res.ok(), await res.text()).toBe(true)
  return (await res.json()) as BoardView
}

const live = (b: BoardView) => b.scene.elements.filter((e) => !e.isDeleted)

async function canvasBox(page: Page) {
  const canvas = page.locator('canvas.excalidraw__canvas.interactive')
  await expect(canvas).toBeVisible()
  const box = await canvas.boundingBox()
  if (!box) throw new Error('no canvas')
  return box
}

test('W6: Excalidraw loads only on a board page', async ({ page, member: _member }) => {
  const scripts: string[] = []
  page.on('response', async (res) => {
    if (res.url().endsWith('.js')) scripts.push(await res.text().catch(() => ''))
  })
  await page.goto('/docs')
  await expect(page.getByTestId('app-switch-boards')).toBeVisible()
  await page.getByTestId('app-switch-boards').click()
  await expect(page.getByTestId('boards-list')).toBeVisible()
  await page.waitForLoadState('networkidle')
  expect(scripts.length).toBeGreaterThan(0)
  expect(scripts.some((s) => s.includes('EXCALIDRAW_ASSET_PATH'))).toBe(false)
})

test('W9: new board → draw a box and a text → it saves itself → reload → find it in search', async ({
  page,
  member,
}) => {
  const word = `Launch${uid()
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 6)}`
  let space = ''
  let id = ''

  await test.step('Whiteboard opens from the app rail; New board opens an empty canvas', async () => {
    await page.goto('/docs')
    await page.getByTestId('app-switch-boards').click()
    await expect(page).toHaveURL(/\/boards$/)
    await page.getByTestId('boards-new-page').click()
    await expect(page).toHaveURL(/\/boards\/[^/]+\/[0-9A-Z]{26}$/)
    const parts = new URL(page.url()).pathname.split('/')
    space = decodeURIComponent(parts[2] ?? '')
    id = parts[3] ?? ''
    expect(space).toBe(member.personal)
    await canvasBox(page)
  })

  await test.step('title it, draw a rectangle and write a text', async () => {
    await page.getByTestId('board-title').fill('Q4 flow')
    await page.getByTestId('board-title').press('Enter')
    const box = await canvasBox(page)
    await page.getByTitle(/^Rectangle/).click()
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.45, { steps: 6 })
    await page.mouse.up()
    await page.getByTitle(/^Text/).click()
    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.6)
    await page.keyboard.type(word)
    await page.keyboard.press('Escape')
  })

  await test.step('it saves within a few seconds, as a file with the text on it', async () => {
    await expect(page.getByTestId('board-status')).toHaveText('Saved', { timeout: 8_000 })
    await expect
      .poll(async () => (await getBoard(member.request, space, id)).texts, { timeout: 8_000 })
      .toEqual([word])
    const b = await getBoard(member.request, space, id)
    expect(b.title).toBe('Q4 flow')
    expect(
      live(b)
        .map((e) => e.type)
        .sort(),
    ).toEqual(['rectangle', 'text'])
    const file = await member.api.readFile(space, b.path)
    expect(file?.content).toContain(`- ${word}`)
  })

  await test.step('a reload shows the same drawing', async () => {
    const before = await getBoard(member.request, space, id)
    await page.reload()
    await canvasBox(page)
    await expect(page.getByTestId('board-title')).toHaveValue('Q4 flow')
    await page.waitForTimeout(2500)
    const after = await getBoard(member.request, space, id)
    expect(after.blobOid).toBe(before.blobOid)
  })

  await test.step('the boards page finds it by the word written on it', async () => {
    await page.getByRole('link', { name: 'All boards' }).click()
    await expect(page).toHaveURL(/\/boards$/)
    await page.getByTestId('boards-search').fill(word)
    await expect(page.getByTestId('board-card-title')).toHaveText(['Q4 flow'])
  })

  await test.step('leaving the board kept the drawing (nothing saved over it on the way out)', async () => {
    await page.waitForTimeout(1500)
    const b = await getBoard(member.request, space, id)
    expect(
      live(b)
        .map((e) => e.type)
        .sort(),
    ).toEqual(['rectangle', 'text'])
    expect(b.texts).toEqual([word])
  })
})

test('W7: a board embedded in a doc shows as a picture and opens the board', async ({
  page,
  member,
}) => {
  const res = await member.request.post('/api/boards', {
    data: {
      title: 'Embedded',
      scene: {
        elements: [
          {
            id: 'r1',
            type: 'rectangle',
            version: 1,
            versionNonce: 1,
            x: 0,
            y: 0,
            width: 120,
            height: 80,
            angle: 0,
            strokeColor: '#1e1e1e',
            backgroundColor: 'transparent',
            fillStyle: 'solid',
            strokeWidth: 2,
            strokeStyle: 'solid',
            roughness: 1,
            opacity: 100,
            groupIds: [],
            frameId: null,
            roundness: null,
            seed: 1,
            isDeleted: false,
            boundElements: null,
            updated: 1,
            link: null,
            locked: false,
          },
        ],
        appState: {},
        files: {},
      },
    },
  })
  expect(res.status(), await res.text()).toBe(201)
  const board = (await res.json()) as BoardView
  const doc = `docs/embed-${uid()}.md`
  await member.api.writeFile(
    member.personal,
    doc,
    `# Plan\n\nBefore\n\n[![Embedded](/${board.path})](/${board.path})\n\nAfter\n`,
  )
  await page.goto(`/docs/${encodeURIComponent(member.personal)}/${doc}`)
  const img = page.locator('.cm-lp-image img[alt="Embedded"]')
  await expect(img).toHaveAttribute('src', /^data:image\/svg\+xml;base64,/, { timeout: 15_000 })
})

test('W8: two people on one board see each other and each other’s strokes within a second', async ({
  page,
  member,
  newMember,
  browser,
}) => {
  const res = await member.request.post('/api/boards', {
    data: { title: 'Together', space: 'team' },
  })
  expect(res.status(), await res.text()).toBe(201)
  const board = (await res.json()) as BoardView
  const other = await newMember()
  const context = await browser.newContext()
  const page2 = await context.newPage()
  try {
    await signIn(page2, other.email)
    const url = `/boards/team/${board.id}`
    await page.goto(url)
    await page2.goto(url)
    await canvasBox(page)
    await canvasBox(page2)

    await test.step('each sees the other is here', async () => {
      await expect(page.getByTestId('board-peers').getByLabel(/is here$/)).toHaveCount(1)
      await expect(page2.getByTestId('board-peers').getByLabel(/is here$/)).toHaveCount(1)
    })

    await test.step('a rectangle drawn by one shows for the other before it is even saved', async () => {
      const box = await canvasBox(page)
      await page.getByTitle(/^Rectangle/).click()
      await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 6 })
      await page.mouse.up()
      const drawnAt = Date.now()
      await expect(page2.getByTestId('board-canvas')).toHaveAttribute('data-shapes', '1', {
        timeout: 1_500,
      })
      expect(Date.now() - drawnAt).toBeLessThan(1_500)
    })

    await test.step('both saves agree: one rectangle on the board', async () => {
      await expect(page.getByTestId('board-status')).toHaveText('Saved', { timeout: 8_000 })
      await expect(page2.getByTestId('board-status')).toHaveText('Saved', { timeout: 8_000 })
      await expect
        .poll(async () => live(await getBoard(member.request, 'team', board.id)).length)
        .toBe(1)
    })

    await test.step('leaving takes them off the other’s board', async () => {
      await page2.close()
      await expect(page.getByTestId('board-peers')).toHaveCount(0, { timeout: 5_000 })
    })
  } finally {
    await context.close()
  }
})
