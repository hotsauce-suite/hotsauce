// The tour's browser shots. Each gets the helpers from rec.mjs and calls startCapture()
// once the page is ready, so sign-in and loading never show up on film.
const B = 'http://localhost:5191'

export const shots = {
  async today({ page, signIn, startCapture, wait, moveTo, point }) {
    await signIn()
    await page.goto(`${B}/today`)
    await wait(1800)
    await startCapture()
    await moveTo(700, 500, 10)
    await wait(700)
    await point(page.getByText('Acme sync').first(), { ms: 700 })
    await wait(900)
    await point(page.getByText('Take notes').first(), { ms: 600 })
    await wait(900)
    await point(page.getByText('Water the office plants'), { ms: 700 })
    await wait(900)
    await point(page.getByRole('heading', { name: 'From your meetings' }), { ms: 700 })
    await wait(800)
    await point(page.getByText('Ada: send pricing one-pager (Fri)'), { ms: 600 })
    await wait(1000)
    await point(page.getByText('Agent brief').first(), { ms: 700 })
    await wait(1200)
  },

  async docs({ page, signIn, startCapture, wait, moveTo, click, type }) {
    await signIn()
    await page.goto(`${B}/docs`)
    await wait(1500)
    await startCapture()
    await moveTo(500, 400, 10)
    await wait(600)
    await click(page.getByRole('treeitem', { name: /^plans/ }))
    await click(page.getByRole('treeitem', { name: /^q4-plan/ }), { after: 1400 })
    // Add a line to the risks list, with a link to the hiring plan.
    const last = page.locator('.cm-line', { hasText: 'We underestimate onboarding' })
    await click(last, { fx: 0.98 })
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await type('We hire too late: see [[hir')
    await wait(900)
    await page.keyboard.press('Enter')
    await wait(1500)
    await click(page.getByTestId('history-toggle'), { after: 2200 })
    const versions = page.getByRole('complementary').last().getByRole('listitem')
    if ((await versions.count()) > 2) await click(versions.nth(2), { after: 2200 })
    await click(page.getByTestId('history-toggle'), { after: 800 })
    await click(page.getByRole('button', { name: 'Reading view' }), { after: 2600 })
  },

  async meetings({ page, signIn, startCapture, wait, moveTo, click, point }) {
    await signIn()
    await page.goto(`${B}/meetings`)
    await wait(1500)
    await startCapture()
    await moveTo(900, 300, 10)
    await wait(800)
    await click(page.getByRole('link', { name: /Acme kickoff/ }).first(), { after: 1800 })
    await point(page.getByText('Summary', { exact: true }).first(), { ms: 900 })
    await wait(1600)
    await point(page.getByText('Needs and objections', { exact: true }).first(), { ms: 900 })
    await wait(1600)
    await page.mouse.wheel(0, 500)
    await wait(1600)
    await point(page.getByText('Transcript').first(), { ms: 900 })
    await wait(1400)
    await point(page.getByText(/On pricing, annual works/), { ms: 900 })
    await wait(2200)
  },

  async ask({ page, signIn, startCapture, wait, moveTo, click, type }) {
    await signIn()
    await page.goto(`${B}/meetings/ask`)
    await wait(1500)
    await startCapture()
    await moveTo(800, 600, 10)
    await click(page.getByPlaceholder('Ask across your meetings'))
    await type('What did Acme ask for on pricing?', 45)
    await page.keyboard.press('Enter')
    await wait(4200)
    await click(page.getByRole('link', { name: 'Agent brief' }))
    await click(page.getByRole('button', { name: 'Write my brief' }), { after: 2600 })
    await page.mouse.wheel(0, 350)
    await wait(2600)
  },

  async tasks({ page, signIn, startCapture, wait, moveTo, click, type }) {
    await signIn()
    await page.goto(`${B}/tasks/today`)
    await wait(1500)
    await startCapture()
    await moveTo(900, 500, 10)
    await wait(600)
    const item = page.getByTestId('meeting-item').filter({ hasText: 'send pricing one-pager' })
    await click(item.getByTestId('meeting-item-add'), { after: 1200 })
    await moveTo(1000, 200, 500)
    await page.keyboard.press('q')
    await wait(400)
    await type('Book the Boston pilot visit next tuesday p2 #Launch', 40)
    await wait(1200)
    await page.keyboard.press('Enter')
    await wait(500)
    await page.keyboard.press('Escape')
    await wait(800)
    await click(page.getByTestId('quick-add-open'), { after: 500 })
    await click(page.getByTestId('ramble-open'), { after: 3600 })
    await click(page.getByTestId('ramble-stop'))
    await page.getByTestId('ramble-review').waitFor({ timeout: 15000 })
    await wait(2200)
    await click(page.getByTestId('ramble-add'), { after: 1800 })
  },

  async notes({ page, signIn, startCapture, wait, moveTo, click, type }) {
    await signIn()
    await page.goto(`${B}/notes`)
    await wait(1500)
    await startCapture()
    await moveTo(900, 450, 10)
    await click(
      page.getByTestId('notes-new-list').or(page.getByTestId('notes-take-note')).first(),
      { after: 500 },
    )
    if (await page.getByTestId('checklist-new').isVisible()) {
      await type('Pilot kit: labels', 40)
      await page.keyboard.press('Enter')
      await type('Spare swabs', 40)
      await page.keyboard.press('Enter')
    } else {
      await page.getByTestId('composer-title').click()
      await type('Pilot kit', 40)
    }
    await wait(500)
    await click(page.getByTestId('composer-close'), { after: 1000 })
    const card = page.getByTestId('note-card').filter({ hasText: 'Board meeting ideas' })
    await click(card.getByTestId('note-card-open').or(card).first(), { after: 900 })
    const editor = page.getByTestId('note-editor')
    await click(editor.getByTestId('note-color'), { after: 500 })
    await click(
      editor.getByTestId('note-color-teal').or(page.getByTestId('note-color-teal')).first(),
      { after: 500 },
    )
    await click(editor.getByTestId('note-editor-pin'), { after: 500 })
    await click(editor.getByTestId('note-editor-close'), { after: 2200 })
  },

  async clipsRecorder({ page, signIn, startCapture, wait, moveTo, point }) {
    await signIn()
    await page.goto(`${B}/clips/new`)
    await wait(1500)
    await page.getByText('Screen only').first().click()
    await wait(1200)
    await page.evaluate(() => {
      for (const o of document.querySelectorAll('option'))
        if (/fake/i.test(o.textContent)) o.textContent = 'Built-in microphone'
    })
    await startCapture()
    await moveTo(900, 450, 10)
    await wait(700)
    await point(page.getByText('Screen only').first(), { ms: 800 })
    await wait(900)
    await point(page.getByRole('button', { name: 'Start recording' }), { ms: 800 })
    await wait(1500)
  },

  async clipsPlayer({ page, signIn, startCapture, wait, moveTo, click, point }) {
    await signIn()
    await page.goto(`${B}/clips`)
    await wait(2500)
    await startCapture()
    await moveTo(900, 450, 10)
    await wait(600)
    await click(page.getByRole('link', { name: /Q4 plan, before/ }).first(), { after: 1200 })
    const v = page.getByTestId('clip-video')
    await v.evaluate((el) => {
      el.muted = true
      el.play()
    })
    await wait(2500)
    await point(page.getByText('Transcript').first(), { ms: 800 })
    await wait(1500)
    await click(page.getByRole('button', { name: '1.5×' }).or(page.getByText('1.5×')).first(), {
      after: 2500,
    })
  },

  async dictate({ page, signIn, startCapture, wait, moveTo, point }) {
    await signIn()
    await page.goto(`${B}/dictate`)
    await wait(1800)
    await startCapture()
    await moveTo(900, 450, 10)
    await wait(800)
    await point(
      page
        .getByRole('button', { name: /Download for Mac/ })
        .or(page.getByRole('link', { name: /Download for Mac/ }))
        .first(),
      { ms: 900 },
    )
    await wait(1800)
    await point(page.getByText('Record a voice note here').first(), { ms: 900 })
    await wait(1200)
    await page.getByText('Record a voice note here').first().click()
    await wait(2500)
  },

  async boards({ page, signIn, startCapture, wait, moveTo }) {
    await signIn()
    await page.goto(`${B}/boards`)
    await wait(1500)
    await page.getByRole('button', { name: 'New board' }).first().click()
    await wait(2500)
    await startCapture()
    await moveTo(900, 450, 10)
    const drag = async (x1, y1, x2, y2) => {
      await moveTo(x1, y1, 400)
      await page.mouse.down()
      await moveTo(x2, y2, 600)
      await page.mouse.up()
      await wait(200)
    }
    await page.mouse.click(1000, 650)
    await wait(300)
    await page.keyboard.press('r')
    await wait(200)
    await drag(650, 280, 900, 430)
    await page.keyboard.press('Escape')
    await page.keyboard.press('o')
    await drag(1150, 280, 1400, 430)
    await page.keyboard.press('Escape')
    await page.keyboard.press('a')
    await drag(910, 355, 1140, 355)
    await page.keyboard.press('Escape')
    await page.keyboard.press('t')
    await moveTo(700, 340, 400)
    await page.mouse.click(700, 340)
    await page.keyboard.type('Kit ships', { delay: 50 })
    await page.keyboard.press('Escape')
    await wait(1200)
  },

  async people({ page, signIn, startCapture, wait, moveTo, point, click, type }) {
    await signIn()
    await page.goto(`${B}/people`)
    await wait(1500)
    await startCapture()
    await moveTo(900, 450, 10)
    await wait(600)
    await point(page.getByText('Priya Natarajan').first(), { ms: 700 })
    await wait(400)
    await click(page.getByText('Dana Lee').first(), { after: 1400 })
    await click(page.getByRole('button', { name: /Add a note/ }), { after: 500 })
    await type('Head of ops at Acme. Likes a short agenda the day before.', 38)
    await wait(300)
    await click(page.getByRole('button', { name: 'Save' }), { after: 1400 })
    await point(page.getByText('Acme sync').first(), { ms: 700 })
    await wait(900)
    await click(page.getByRole('link', { name: 'acme.com', exact: true }).last(), { after: 2200 })
  },

  async forms({ page, signIn, startCapture, wait, moveTo, click, type }) {
    await signIn()
    await page.goto(`${B}/forms`)
    await wait(1500)
    await startCapture()
    await moveTo(900, 450, 10)
    await click(page.getByPlaceholder(/New form title/))
    await type('Site visit sign-up', 40)
    await click(page.getByRole('button', { name: 'New form' }), { after: 1800 })
    await click(page.getByRole('button', { name: 'Add question' }), { after: 1500 })
  },

  async booking({ page, signIn, startCapture, wait, moveTo, click, type }) {
    await signIn()
    await page.goto(`${B}/meetings/booking`)
    await wait(1500)
    await startCapture()
    await moveTo(900, 450, 10)
    await click(page.getByRole('button', { name: 'New booking link' }), { after: 700 })
    await click(page.getByTestId('booking-title'))
    await type('Intro call', 45)
    await wait(1500)
  },

  async briefcast({ page, signIn, startCapture, wait, moveTo, point, click }) {
    await signIn()
    await page.goto(`${B}/briefcast`)
    await wait(1500)
    await startCapture()
    await moveTo(900, 450, 10)
    await wait(600)
    await click(page.getByRole('button', { name: /Make today/ }), { after: 2200 })
    const play = page.getByRole('button', { name: /^Play/ }).first()
    if (await play.count()) await click(play, { after: 900 })
    await point(page.getByText(/three meetings today/).first(), { ms: 900 })
    await page.mouse.wheel(0, 260)
    await wait(1800)
    await page.mouse.wheel(0, 300)
    await wait(1600)
    await point(page.getByRole('button', { name: 'Get my private feed link' }), { ms: 700 })
    await click(page.getByRole('button', { name: 'Get my private feed link' }), { after: 2000 })
  },

  async files({ page, signIn, startCapture, wait, moveTo, point, click, type }) {
    const DIR = process.env.DEMO_FILES
    await signIn()
    await page.goto(`${B}/files`)
    await wait(2000)
    await startCapture()
    await moveTo(900, 450, 10)
    await wait(500)
    await click(page.getByRole('button', { name: 'New folder' }), { after: 400 })
    await type('Launch', 70)
    await click(page.getByRole('button', { name: 'Create' }), { after: 1000 })
    await click(page.getByRole('button', { name: /^Launch/ }).first(), { after: 1000 })
    const chooser = page.waitForEvent('filechooser')
    await point(page.getByRole('button', { name: 'Upload' }).last(), { ms: 600 })
    await page.getByRole('button', { name: 'Upload' }).last().click()
    await (await chooser).setFiles([
      `${DIR}/Pilot budget.pdf`,
      `${DIR}/Quarterly plan.docx`,
      `${DIR}/Sign-ups chart.png`,
    ])
    await wait(2500)
    await click(page.getByRole('button', { name: /^Sign-ups chart/ }).first(), { after: 2600 })
    await page.keyboard.press('Escape')
    await wait(700)
    await click(page.getByRole('searchbox', { name: 'Search files' }), { after: 200 })
    await type('courier', 80)
    await wait(2200)
  },
}
