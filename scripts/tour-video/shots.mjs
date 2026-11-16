// The tour's browser shots. Each gets the helpers from rec.mjs and calls startCapture()
// once the page is ready, so sign-in and loading never show up on film.
const B = process.env.TOUR_BASE ?? 'http://localhost:5191'

export const shots = {
  async today({ page, signIn, startCapture, wait, moveTo, point, click }) {
    await signIn()
    await page.goto(`${B}/today`)
    await wait(1800)
    await startCapture()
    await moveTo(700, 500, 10)
    await wait(600)
    await point(page.getByTestId('today-greeting'), { ms: 700 })
    await wait(700)
    // A new teammate's first steps, at the top until done or hidden.
    await point(page.getByTestId('today-start-count'), { ms: 700 })
    await wait(900)
    await click(page.getByTestId('today-weather-on'), { ms: 700 })
    await wait(900)
    await point(page.getByTestId('today-time'), { ms: 600 })
    await wait(800)
    await point(page.getByText('Take notes').first(), { ms: 600 })
    await wait(800)
    await point(page.getByText('Water the office plants'), { ms: 700 })
    await wait(800)
    await click(page.getByTestId('today-edit'), { ms: 700 })
    await wait(700)
    await click(page.getByTestId('today-add-tile'), { ms: 600 })
    await wait(700)
    await click(page.getByTestId('today-add-week'), { ms: 700 })
    await wait(700)
    await click(page.getByTestId('today-done'), { ms: 700 })
    await wait(900)
    await point(page.getByTestId('today-week'), { ms: 800 })
    await wait(1400)
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

  // The built-in assistant (⌘J), opened over a doc, answering with links to what it used.
  async assistant({ page, signIn, startCapture, wait, moveTo, click, type }) {
    await signIn()
    await page.goto(`${B}/docs`)
    await wait(1200)
    await page.getByRole('treeitem', { name: /^plans/ }).click()
    await page.getByRole('treeitem', { name: /^q4-plan/ }).click()
    await wait(1500)
    await startCapture()
    await moveTo(800, 450, 10)
    await wait(900)
    await click(page.getByRole('button', { name: 'Ask the assistant' }), { after: 1200 })
    await click(page.getByRole('textbox', { name: /^Message Ask/ }))
    await type('When is standup, and when are demos?', 45)
    await page.keyboard.press('Enter')
    await wait(3500)
    const answer = page
      .getByRole('complementary')
      .last()
      .getByRole('link', { name: 'Team rituals' })
    await click(answer, { after: 2600 })
  },

  // Check-ins: answer this week's question, then reply to a teammate.
  async checkins({ page, signIn, startCapture, wait, moveTo, click, type }) {
    await signIn()
    await page.goto(`${B}/checkins`)
    await wait(1500)
    await startCapture()
    await moveTo(800, 400, 10)
    await wait(700)
    await click(page.getByRole('link', { name: /What will you get done this week/ }), {
      after: 1400,
    })
    await click(page.getByTestId('checkin-answer'))
    await type('Ship the Q1 roadmap draft and book the field visits.', 40)
    await wait(500)
    await click(page.getByTestId('checkin-submit'), { after: 1500 })
    await click(page.getByTestId('checkin-reply-open').first(), { after: 600 })
    await type('Nice. Shout if the quote isn’t in by Wednesday.', 40)
    await click(page.getByTestId('checkin-reply-send').first(), { after: 2200 })
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

  // The Clips player, with a clip from DEMO_CLIP (a dir holding composite.mp4 and thumb.jpg: footage with
  // the camera bubble in it, made with the server's own composite()). The clip's API answers are
  // routed here so the shot needs no real recording, transcriber or language model.
  async clipsPlayer({ page, signIn, startCapture, wait, moveTo, click, point, type }) {
    const dir = process.env.DEMO_CLIP
    if (!dir) throw new Error('set DEMO_CLIP to a dir with composite.mp4 and thumb.jpg')
    // Recorded a little before the page clock (TOUR_CLOCK), so it reads as this morning.
    const now = new Date(
      (process.env.TOUR_CLOCK ? Date.parse(process.env.TOUR_CLOCK) : Date.now()) - 50 * 60_000,
    ).toISOString()
    let clip = {
      id: 'demo-q4',
      title: 'Q4 plan, before Friday’s board meeting',
      summary: null,
      mode: 'screen_camera',
      status: 'ready',
      error: null,
      durationMs: 21000,
      sizeBytes: 4_000_000,
      width: 1920,
      height: 1080,
      mimeType: 'video/mp4',
      owner: { name: 'Ada Lovelace', email: 'ada@example.test' },
      isOwner: true,
      createdAt: now,
      updatedAt: now,
      transcriptStatus: 'ready',
      transcriptError: null,
      compositeStatus: 'ready',
      screenSurface: 'browser',
      screenLabel: 'Q4 plan',
      speakers: [{ id: 0, name: 'Speaker 1', named: false }],
      aiSummary: null,
      aiActions: null,
      videoUrl: '/demo-clip/composite.mp4',
      thumbUrl: '/demo-clip/thumb.jpg',
      downloadUrl: '/demo-clip/composite.mp4',
    }
    const transcript = [
      {
        start: 0,
        end: 4,
        speaker: 0,
        text: 'Quick one before Friday: here’s the Q4 plan the board will see.',
      },
      {
        start: 4,
        end: 9,
        speaker: 0,
        text: 'I added a risk under Risks, that we hire too late, and linked it to the hiring plan.',
      },
      {
        start: 9,
        end: 14,
        speaker: 0,
        text: 'History shows Priya’s edit from Monday, when she added the second assay scientist.',
      },
      {
        start: 14,
        end: 21,
        speaker: 0,
        text: 'Can you read it before Friday and leave comments right in the doc? Thanks.',
      },
    ]
    const ctx = page.context()
    const json = (route, body) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    await ctx.route('**/demo-clip/*', (route) =>
      route.fulfill({ path: `${dir}/${new URL(route.request().url()).pathname.split('/').pop()}` }),
    )
    await ctx.route('**/api/clips**', async (route) => {
      const req = route.request()
      const url = new URL(req.url())
      if (url.pathname === '/api/clips/config') return json(route, { available: true })
      if (url.pathname === '/api/clips') return json(route, { clips: [clip] })
      if (url.pathname === '/api/clips/demo-q4' && req.method() === 'PATCH') {
        const name = Object.values(req.postDataJSON().speakers ?? {})[0]
        if (name) clip = { ...clip, speakers: [{ id: 0, name, named: true }] }
        return json(route, clip)
      }
      if (url.pathname === '/api/clips/demo-q4/ai') {
        await new Promise((r) => setTimeout(r, 1200))
        const { kind } = req.postDataJSON()
        clip =
          kind === 'summary'
            ? {
                ...clip,
                aiSummary:
                  'Ada walks through the Q4 plan before Friday’s board meeting: a new hiring risk, linked to the hiring plan, and Priya’s latest edit. She asks for comments in the doc before Friday.',
              }
            : {
                ...clip,
                aiActions:
                  '- [ ] Read the Q4 plan before Friday\n- [ ] Leave comments in the doc\n- [ ] Check the hiring plan risk',
              }
        return json(route, clip)
      }
      if (url.pathname === '/api/clips/demo-q4') return json(route, { clip, transcript })
      return route.fallback()
    })
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
    await point(page.getByTestId('clip-speakers'), { ms: 700 })
    await click(page.getByTestId('clip-speakers').getByRole('button').first(), { after: 400 })
    await page.keyboard.press('ControlOrMeta+a')
    await type('Ada', 70)
    await page.keyboard.press('Enter')
    await wait(1400)
    await click(page.getByTestId('clip-summarize'), { after: 2600 })
    await click(page.getByTestId('clip-actions'), { after: 1400 })
    await page.mouse.wheel(0, 300)
    await wait(1600)
    await click(page.getByRole('button', { name: '1.5×' }).or(page.getByText('1.5×')).first(), {
      after: 2000,
    })
  },

  async dictate({ page, signIn, startCapture, wait, moveTo, point }) {
    await signIn()
    await page.goto(`${B}/dictate`)
    await wait(1800)
    await startCapture()
    await moveTo(900, 450, 10)
    await wait(800)
    await point(page.getByRole('button', { name: 'Connect this Mac' }).first(), { ms: 900 })
    await wait(1800)
    await point(page.getByText('Record a voice note here').first(), { ms: 900 })
    await wait(1200)
    await page.getByText('Record a voice note here').first().click()
    await wait(2500)
  },

  // The Mac app's step-by-step setup, from the app's own drawings (mac-setup/index.html).
  async macSetup({ page, startCapture, wait, moveTo, click }) {
    await page.goto(new URL('./mac-setup/index.html', import.meta.url).href)
    await page.evaluate(() => document.fonts.ready)
    await wait(600)
    await startCapture()
    const show = (s) => page.evaluate((n) => window.show(n), s)
    const hot = (id) => page.getByTestId(id)
    await moveTo(900, 600, 10)
    await wait(500)
    await click(hot('field'), { ms: 700 })
    await wait(500)
    await click(hot('continueField'), { ms: 600 })
    await show(1)
    await wait(1300)
    await click(hot('next'), { ms: 800 })
    await show(2)
    await wait(1200)
    await click(hot('google'), { ms: 800 })
    await wait(500)
    await show(3)
    await wait(2600)
    await click(hot('next'), { ms: 800 })
    await show(4)
    await wait(2600)
    await click(hot('skip'), { ms: 700 })
    await show(5)
    await wait(1200)
    await click(hot('open'), { ms: 700, after: 1200 })
  },

  // Send feedback from any page, with a picture of that page attached.
  async feedback({ page, signIn, startCapture, wait, moveTo, click, type }) {
    await signIn()
    await page.goto(`${B}/tasks`)
    await wait(2000)
    await startCapture()
    await moveTo(900, 450, 10)
    await wait(700)
    await click(page.getByRole('link', { name: 'Send feedback' }), { ms: 900, after: 1400 })
    await click(page.getByText('I have an idea'), { ms: 700 })
    await click(page.getByRole('textbox').first(), { ms: 500 })
    await type('Let me drag a task onto a day in the week view to reschedule it.', 38)
    await wait(500)
    await click(page.getByRole('button', { name: 'Add a picture of the page you were on' }), {
      ms: 700,
      after: 1300,
    })
    await click(page.getByRole('button', { name: 'Send' }), { ms: 700, after: 2200 })
    await moveTo(760, 700, 700)
    await wait(1800)
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
    await click(page.getByTestId('new-form'), { after: 600 })
    const inTeam = page.getByTestId('new-form-in-team')
    if (await inTeam.isVisible().catch(() => false)) await click(inTeam, { after: 1500 })
    // The new form opens with its name selected, ready to type over.
    await page.getByTestId('form-title').waitFor()
    await wait(600)
    await type('Site visit sign-up', 40)
    await wait(600)
    await click(page.getByRole('button', { name: 'Add question' }), { after: 1500 })
  },

  async sign({ page, signIn, startCapture, wait, moveTo, click, type }) {
    await signIn()
    await page.goto(`${B}/files?space=team&folder=Pilot%20launch`)
    await wait(1500)
    await startCapture()
    await moveTo(900, 450, 10)
    const row = page.getByTestId('files-row').filter({ hasText: 'Acme pilot one-pager.pdf' })
    await click(row.getByTestId('files-open'), { after: 1200 })
    await click(page.getByTestId('file-send-for-signature'), { after: 1500 })
    await page.getByTestId('sign-page-1').locator('canvas').waitFor()
    await wait(900)
    const layer = page.locator('[data-page-layer="1"]')
    await click(page.getByTestId('sign-add-signature'), { after: 500 })
    await click(layer, { fx: 0.3, fy: 0.62, after: 700 })
    await click(page.getByTestId('sign-add-date'), { after: 500 })
    await click(layer, { fx: 0.72, fy: 0.62, after: 900 })
    await click(page.getByTestId('sign-start'), { after: 1200 })
    await click(page.getByTestId('sign-field-f1'), { after: 800 })
    await page.getByTestId('signature-typed').fill('')
    await click(page.getByTestId('signature-typed'))
    await type('Ada Lovelace', 60)
    await wait(700)
    await click(page.getByTestId('signature-done'), { after: 900 })
    await click(page.getByTestId('sign-consent'), { after: 500 })
    await click(page.getByTestId('sign-finish'), { after: 2200 })
    await page.getByTestId('sign-finished').waitFor()
    await wait(1500)
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
    // The live demo's mock searches uploaded files by name (it has no PDF text).
    await type('budget', 80)
    await wait(2200)
  },

  // Links: reading progress in the list, a highlight with a note, then a paper's details.
  async links({ page, signIn, startCapture, wait, moveTo, point, click, type }) {
    await signIn()
    await page.goto(`${B}/links`)
    await wait(1500)
    await startCapture()
    await moveTo(800, 500, 10)
    await wait(700)
    const review = page.getByTestId('links-list').getByText('How to run a weekly review')
    await point(review, { ms: 700 })
    await wait(900)
    await click(review, { after: 1600 })
    await click(page.getByTestId('link-start-over'), { after: 1200 })
    // Highlight a sentence by dragging across it, then add a note.
    const line = page.getByTestId('link-body').getByText(/Dropping is allowed/)
    const box = await line.boundingBox()
    if (box) {
      const text = await line.evaluate((el) => {
        const range = document.createRange()
        const node = [...el.childNodes].find((n) => n.textContent?.includes('Dropping is allowed'))
        const at = node?.textContent?.indexOf('Dropping is allowed') ?? -1
        if (!node || at < 0) return null
        range.setStart(node, at)
        range.setEnd(node, at + 'Dropping is allowed.'.length)
        const r = range.getBoundingClientRect()
        return { x0: r.left + 2, x1: r.right - 1, y: r.top + r.height / 2 }
      })
      if (text) {
        await moveTo(text.x0, text.y, 600)
        await page.mouse.down()
        await moveTo(text.x1, text.y, 700)
        await page.mouse.up()
        await wait(700)
        await click(page.getByTestId('link-add-note'), { after: 600 })
        await type('Let’s drop two old projects this week.', 45)
        await click(page.getByTestId('link-note-save'), { after: 1400 })
      }
    }
    await click(page.getByRole('link', { name: 'Links' }).first(), { after: 1400 })
    await click(page.getByTestId('links-view-highlights'), { after: 1800 })
    await click(page.getByTestId('links-view-unread'), { after: 1000 })
    await click(page.getByTestId('links-list').getByText('Meeting notes that write themselves'), {
      after: 1400,
    })
    await click(page.getByTestId('link-start-over'), { after: 900 })
    await point(page.getByTestId('link-paper'), { ms: 700 })
    await wait(900)
    await point(page.getByTestId('link-abstract'), { ms: 700 })
    await wait(1800)
  },
}
