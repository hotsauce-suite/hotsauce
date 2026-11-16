import type { Page, Route } from '@playwright/test'
import { expect, newForm, replaceLine, signIn, test, uid } from './fixtures'

// docs/PLAN-consistency.md, requirements 1–5: every app's list says the same thing when it
// can't load ("Couldn't load … Try again", which loads it without reloading the page) and shows
// the same kind of empty screen, never the empty one while the list has in fact failed.

interface AppList {
  /** The app as its page title names it. */
  name: string
  /** Where its list lives. */
  url: string
  /** The request that fills the list: the path of a GET under `/api`. */
  api: string | RegExp
  /** The words after "Couldn't load". */
  says: string
  /** The same answer with nothing in the list; null where a list can't be empty. */
  empty: ((body: unknown) => unknown) | null
}

const none =
  (...keys: string[]) =>
  (body: unknown) => ({
    ...(body as object),
    ...Object.fromEntries(keys.map((k) => [k, []])),
  })

const APPS: AppList[] = [
  { name: 'Today', url: '/today', api: '/api/today', says: 'your day', empty: null },
  {
    name: 'Meetings',
    url: '/meetings',
    api: '/api/meetings',
    says: 'your meetings',
    empty: () => [],
  },
  {
    name: 'Voice notes',
    url: '/dictate/voice',
    api: '/api/meetings',
    says: 'your voice notes',
    empty: () => [],
  },
  { name: 'Clips', url: '/clips', api: '/api/clips', says: 'your clips', empty: none('clips') },
  { name: 'Tasks', url: '/tasks/all', api: '/api/tasks', says: 'your tasks', empty: none('tasks') },
  { name: 'Notes', url: '/notes', api: '/api/notes', says: 'your notes', empty: none('notes') },
  {
    name: 'Boards',
    url: '/boards',
    api: '/api/boards',
    says: 'your boards',
    empty: none('boards'),
  },
  { name: 'People', url: '/people', api: '/api/people', says: 'the people', empty: none('people') },
  {
    name: 'Files',
    url: '/files',
    api: '/api/files',
    says: 'the team files',
    empty: none('files', 'folders'),
  },
  { name: 'Links', url: '/links', api: '/api/links', says: 'your links', empty: none('links') },
  { name: 'Forms', url: '/forms', api: '/api/forms', says: 'your forms', empty: none('forms') },
  {
    name: 'Check-ins',
    url: '/checkins',
    api: '/api/checkins',
    says: 'the check-ins',
    empty: none('checkins'),
  },
  {
    name: 'Tables',
    url: '/tables',
    api: '/api/tables',
    says: 'your tables',
    empty: none('tables'),
  },
  { name: 'Pages', url: '/pages', api: '/api/pages', says: 'the pages', empty: none('pages') },
  {
    name: 'Briefcast',
    url: '/briefcast',
    api: '/api/briefcast',
    says: 'your briefcast',
    empty: null,
  },
  {
    name: 'Docs',
    url: '/docs',
    api: /^\/api\/spaces\/[^/]+\/tree$/,
    says: 'your docs',
    empty: null,
  },
]

/** Answers the app's list request with `answer` until the returned switch is turned off. */
async function intercept(page: Page, app: AppList, answer: (route: Route) => Promise<void>) {
  const state = { on: true }
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const hit = typeof app.api === 'string' ? path === app.api : app.api.test(path)
    if (!state.on || !hit || request.method() !== 'GET') return route.fallback()
    await answer(route)
  })
  return state
}

for (const app of APPS) {
  test(`${app.name}: a list that fails says so, and Try again loads it`, async ({ page }) => {
    const failing = await intercept(page, app, (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'internal', message: 'SQLITE_BUSY: database is locked' },
        }),
      }),
    )
    // No live updates: a change another test makes at the same moment would load the list again
    // by itself (Check-ins listens for them) and take the block away before Try again is pressed.
    await page.routeWebSocket(/\/ws(\?|$)/, () => {})
    await page.goto(app.url)
    const block = page.getByTestId('load-error').first()
    await expect(block).toContainText(`Couldn’t load ${app.says}.`)
    // The server's own sentence helps no one, and "nothing here yet" would be untrue.
    await expect(page.getByText('SQLITE_BUSY')).toHaveCount(0)
    await expect(page.locator('[data-empty-state]')).toHaveCount(0)

    failing.on = false
    let reloaded = false
    page.on('load', () => {
      reloaded = true
    })
    const answered = page.waitForResponse((response) => {
      const path = new URL(response.url()).pathname
      const hit = typeof app.api === 'string' ? path === app.api : app.api.test(path)
      return hit && response.request().method() === 'GET' && response.ok()
    })
    await block.getByRole('button', { name: 'Try again' }).click()
    await answered
    await expect(page.getByTestId('load-error')).toHaveCount(0)
    expect(reloaded).toBe(false)
  })

  const { empty } = app
  if (!empty) continue
  test(`${app.name}: an empty list shows the empty screen`, async ({ page }) => {
    await intercept(page, app, async (route) => {
      const response = await route.fetch()
      await route.fulfill({ response, json: empty(await response.json()) })
    })
    await page.goto(app.url)
    const screen = page.locator('[data-empty-state]').first()
    await expect(screen).toBeVisible()
    await expect(screen.locator('svg').first()).toBeVisible()
    await expect(page.getByTestId('load-error')).toHaveCount(0)
  })
}

// Requirement 8: the app's one red button is the last control at the top right of its page, on a
// computer and on a phone, and it always shows its words.

const MAIN_BUTTONS: { name: string; url: string; says: string; admin?: boolean }[] = [
  { name: 'Docs', url: '/docs', says: 'New doc' },
  { name: 'Meetings', url: '/meetings', says: 'New meeting' },
  { name: 'Voice notes', url: '/dictate/voice', says: 'Record a voice note' },
  { name: 'Clips', url: '/clips', says: 'Record a clip' },
  { name: 'Tasks', url: '/tasks/all', says: 'New task' },
  { name: 'Notes', url: '/notes', says: 'New note' },
  { name: 'Boards', url: '/boards', says: 'New board' },
  { name: 'Files', url: '/files', says: 'Upload' },
  { name: 'Links', url: '/links', says: 'Save a link' },
  { name: 'Forms', url: '/forms', says: 'New form' },
  // Only an admin sets up check-ins.
  { name: 'Check-ins', url: '/checkins', says: 'New check-in', admin: true },
  { name: 'Tables', url: '/tables', says: 'New table' },
  { name: 'Briefcast', url: '/briefcast', says: 'Make today’s briefing' },
]

for (const width of [
  { label: 'computer', viewport: { width: 1280, height: 800 } },
  { label: 'phone', viewport: { width: 390, height: 844 } },
]) {
  test.describe(`the main button, on a ${width.label}`, () => {
    test.use({ viewport: width.viewport, signedIn: false })
    for (const app of MAIN_BUTTONS) {
      test(`${app.name}: "${app.says}" is at the top right`, async ({ page, user }) => {
        await signIn(page, app.admin ? 'e2e-admin@example.test' : user.email)
        await page.goto(app.url)
        const header = page.getByTestId('page-header')
        const button = header.locator('[data-main-button]')
        await expect(button).toHaveCount(1)
        await expect(button).toBeVisible()
        await expect(button).toHaveText(app.says)
        const bar = await header.boundingBox()
        const box = await button.boundingBox()
        if (!bar || !box) throw new Error('no top bar')
        // Nothing sits to its right, and nothing pushes it off the screen.
        const gap = bar.x + bar.width - (box.x + box.width)
        expect(gap).toBeGreaterThanOrEqual(0)
        expect(gap).toBeLessThanOrEqual(24)
        // The title beside it is still there to read.
        const title = await header.getByRole('heading').boundingBox()
        expect(title?.width ?? 0).toBeGreaterThanOrEqual(40)
        // Its words fit on one line.
        expect(box.height).toBeLessThanOrEqual(40)
      })
    }
  })
}

// Requirement 11: on a phone the top bar is the menu (or the way back), the title, the one main
// button with its words, and "More" for everything else. The Ask button covers none of it.

test.describe('a phone’s top bar', () => {
  test.use({ viewport: { width: 390, height: 844 }, signedIn: false })

  /** The controls in the top bar that are not the menu, the way back, the main button or More. */
  const strays = (page: Page) =>
    page
      .getByTestId('page-header')
      .locator('button:visible, a:visible')
      .evaluateAll((nodes) =>
        nodes
          .filter(
            (n) =>
              !n.matches(
                '[data-main-button], [data-testid="page-more"], [data-testid="page-back"], [aria-label="Open sidebar"]',
              ),
          )
          .map((n) => n.getAttribute('data-testid') ?? n.textContent ?? ''),
      )

  for (const app of MAIN_BUTTONS) {
    test(`${app.name}: nothing but the menu, the title, the main button and More`, async ({
      page,
      user,
    }) => {
      await signIn(page, app.admin ? 'e2e-admin@example.test' : user.email)
      await page.goto(app.url)
      const header = page.getByTestId('page-header')
      await expect(header.locator('[data-main-button]')).toBeVisible()
      expect(await strays(page)).toEqual([])
      // The title is not squeezed away.
      const title = await header.getByRole('heading').boundingBox()
      expect(title?.width ?? 0).toBeGreaterThanOrEqual(60)
      // The Ask button sits clear of every control on the page.
      const ask = await page.getByTestId('assistant-open').boundingBox()
      if (!ask) throw new Error('no Ask button')
      const covered = await page
        .locator('main button:visible, main a:visible, main input:visible')
        .evaluateAll(
          (nodes, a) =>
            nodes
              .filter((n) => {
                const r = n.getBoundingClientRect()
                return (
                  r.width > 0 &&
                  r.left < a.x + a.width &&
                  r.right > a.x &&
                  r.top < a.y + a.height &&
                  r.bottom > a.y &&
                  // Only what is on the screen now: a list scrolls under the button.
                  r.bottom <= window.innerHeight
                )
              })
              .map((n) => n.getAttribute('data-testid') ?? n.textContent ?? ''),
          ask,
        )
      expect(covered).toEqual([])
    })
  }

  test('a form: its status shows, Copy link, Open and Settings are behind More', async ({
    page,
    user,
  }) => {
    await signIn(page, user.email)
    await page.goto('/forms')
    await newForm(page, `Phone ${uid()}`)
    expect(await strays(page)).toEqual([])
    await expect(page.getByTestId('form-status')).toHaveText('Saved')
    await page.getByTestId('page-more').click()
    await expect(page.getByRole('menuitem', { name: 'Settings' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Delete form' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Copy link' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Open the form' })).toHaveAttribute(
      'href',
      /\/f\//,
    )
  })

  test('a doc: its name, Share, and the rest behind More', async ({ page, user }) => {
    await signIn(page, user.email)
    await page.goto('/docs')
    await page.getByTestId('docs-new').click()
    await replaceLine(page, 'Untitled', '# Field notes')
    await expect(page.getByTestId('doc-title')).toHaveText('Field notes')
    const bar = page.locator('header').first()
    await expect(bar.getByTestId('share-menu')).toHaveText('Share')
    await expect(bar.getByTestId('history-toggle')).toHaveCount(0)
    await page.getByTestId('page-more').click()
    for (const name of ['Add to Starred', 'Reading view', 'History', 'Save version'])
      await expect(page.getByRole('menuitem', { name })).toBeVisible()
    await page.getByRole('menuitem', { name: 'Reading view' }).click()
    await expect(page.getByTestId('reading-view')).toBeVisible()
    // More closes on a second press, and Save version opens from it.
    const more = page.getByTestId('page-more')
    await more.click()
    await expect(page.getByRole('menu')).toBeVisible()
    await more.click()
    await expect(page.getByRole('menu')).toHaveCount(0)
    await more.click()
    await page.getByRole('menuitem', { name: 'Save version' }).click()
    await expect(page.getByRole('dialog', { name: 'Save version' })).toBeVisible()
  })

  test('Files: New folder is behind More and still makes a folder', async ({ page, user }) => {
    await signIn(page, user.email)
    await page.goto('/files')
    await page.getByTestId('page-more').click()
    await page.getByRole('menuitem', { name: 'New folder' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
  })

  test('a board: Share and Delete are behind More, and Ask sits above the board’s tools', async ({
    page,
    user,
  }) => {
    await signIn(page, user.email)
    await page.goto('/boards')
    await page.locator('[data-main-button]').click()
    await expect(page).toHaveURL(/\/boards\/[^/]+\/.+/)
    await expect(page.getByTestId('board-title')).toBeVisible()
    expect(await strays(page)).toEqual([])
    const ask = await page.getByTestId('assistant-open').boundingBox()
    // Clear of the board's own bar along the bottom (undo, redo, its menu).
    expect(844 - ((ask?.y ?? 0) + (ask?.height ?? 0))).toBeGreaterThanOrEqual(130)
    await page.getByTestId('page-more').click()
    for (const name of ['Copy link', 'Copy to paste into a doc', 'Delete board'])
      await expect(page.getByRole('menuitem', { name })).toBeVisible()
  })
})

// Round 3, requirements 12 to 18: one row above every list. Tabs on the left, search on the
// right, right under the top bar; no search field in the top bar; two page widths; the intro
// paragraph only on the empty screen; on a phone the search sits under the tabs, full width.

interface ListRow {
  name: string
  url: string
  /** The tabs in order, or null where the list has none. */
  tabs: string[] | null
  search: string
  width: 'reading' | 'gallery'
}

const LIST_ROWS: ListRow[] = [
  {
    name: 'Tasks',
    url: '/tasks',
    tabs: ['Inbox', 'Today', 'Upcoming', 'All', 'Done'],
    search: 'tasks-search',
    width: 'reading',
  },
  { name: 'Meetings', url: '/meetings', tabs: null, search: 'meetings-search', width: 'reading' },
  {
    name: 'Clips',
    url: '/clips',
    tabs: ['Personal', 'Team'],
    search: 'clips-search',
    width: 'gallery',
  },
  {
    name: 'Boards',
    url: '/boards',
    tabs: ['Personal', 'Team'],
    search: 'boards-search',
    width: 'gallery',
  },
  {
    name: 'Notes',
    url: '/notes',
    tabs: ['All', 'Personal', 'Team'],
    search: 'notes-search',
    width: 'gallery',
  },
  { name: 'Files', url: '/files', tabs: null, search: 'files-search', width: 'gallery' },
  {
    name: 'Links',
    url: '/links',
    tabs: ['Unread', 'Archive', 'Highlights'],
    search: 'links-search',
    width: 'reading',
  },
  {
    name: 'Forms',
    url: '/forms',
    tabs: ['All', 'Personal', 'Team'],
    search: 'forms-search',
    width: 'reading',
  },
  {
    name: 'Tables',
    url: '/tables',
    tabs: ['All', 'Personal', 'Team'],
    search: 'tables-search',
    width: 'reading',
  },
  {
    name: 'Pages',
    url: '/pages',
    tabs: ['All', 'Personal', 'Team'],
    search: 'pages-search',
    width: 'reading',
  },
  { name: 'Check-ins', url: '/checkins', tabs: null, search: 'checkins-search', width: 'reading' },
  { name: 'People', url: '/people', tabs: null, search: 'people-search', width: 'reading' },
]

for (const width of [
  { label: 'computer', viewport: { width: 1280, height: 800 } },
  { label: 'phone', viewport: { width: 390, height: 844 } },
]) {
  test.describe(`the row above a list, on a ${width.label}`, () => {
    test.use({ viewport: width.viewport })
    const phone = width.label === 'phone'

    for (const app of LIST_ROWS) {
      test(`${app.name}: tabs on the left, search on the right`, async ({ page }) => {
        await page.goto(app.url)
        const header = page.getByTestId('page-header')
        const row = page.getByTestId('list-bar')
        await expect(row).toHaveCount(1)
        await expect(row).toBeVisible()
        // The search is in the row, never in the top bar.
        await expect(header.locator('input[type="search"]')).toHaveCount(0)
        const search = row.getByTestId(app.search)
        await expect(search).toBeVisible()

        const column = page.locator(`[data-list-width="${app.width}"]`)
        await expect(column).toHaveCount(1)
        const [bar, rowBox, searchBox, col] = await Promise.all([
          header.boundingBox(),
          row.boundingBox(),
          search.boundingBox(),
          column.boundingBox(),
        ])
        if (!bar || !rowBox || !searchBox || !col) throw new Error('nothing to measure')
        // The row is the first thing under the top bar.
        expect(rowBox.y - (bar.y + bar.height)).toBeLessThanOrEqual(32)
        // The search ends at the row's right edge.
        expect(
          Math.abs(rowBox.x + rowBox.width - (searchBox.x + searchBox.width)),
        ).toBeLessThanOrEqual(2)

        if (app.tabs) {
          const tabs = row.getByRole('tab')
          await expect(tabs).toHaveText(app.tabs)
          await expect(row.getByRole('tab', { selected: true })).toHaveText(app.tabs[0] as string)
          const first = await tabs.first().boundingBox()
          if (!first) throw new Error('no tabs')
          // The tabs start at the row's left edge.
          expect(first.x - rowBox.x).toBeLessThanOrEqual(8)
          // A screen reader hears the list as the chosen tab's (one panel, named by that tab).
          const panel = page.getByRole('tabpanel', { name: app.tabs[0] as string })
          await expect(panel).toHaveCount(1)
          const panelId = await panel.getAttribute('id')
          for (const tab of await tabs.all()) {
            await expect(tab).toHaveAttribute('aria-controls', panelId as string)
          }
          if (phone) {
            // On a phone the search is under the tabs.
            expect(searchBox.y).toBeGreaterThan(first.y + first.height - 1)
          } else {
            expect(searchBox.x).toBeGreaterThan(first.x + first.width)
            expect(
              Math.abs(searchBox.y + searchBox.height / 2 - (first.y + first.height / 2)),
            ).toBeLessThanOrEqual(6)
          }
        }
        if (phone) {
          // Full width, and nothing scrolls sideways: not the list's scrolling area, not the tabs.
          expect(searchBox.width).toBeGreaterThanOrEqual(rowBox.width - 2)
          for (const area of [column.locator('..'), row.getByTestId('list-tabs')]) {
            if ((await area.count()) === 0) continue
            const wide = await area.evaluate((el) => el.scrollWidth - el.clientWidth)
            expect(wide).toBeLessThanOrEqual(0)
          }
        }
      })
    }
  })
}

test.describe('the two list widths', () => {
  test.use({ viewport: { width: 1600, height: 900 } })
  test('rows of text share one column, grids of cards share a wider one', async ({ page }) => {
    for (const app of LIST_ROWS) {
      await page.goto(app.url)
      const box = await page.locator(`[data-list-width="${app.width}"]`).boundingBox()
      expect(box?.width, app.name).toBe(app.width === 'reading' ? 768 : 1152)
    }
  })
})

test.describe('the row above a list', () => {
  test('Forms: search filters by name, and the tabs sort Personal from Team', async ({ page }) => {
    const id = uid()
    await page.goto('/forms')
    await newForm(page, `Lunch order ${id}`)
    await page.goto('/forms')
    const rows = page.getByTestId('forms-list').getByRole('listitem')
    await expect(rows.filter({ hasText: `Lunch order ${id}` })).toHaveCount(1)
    // With something in the list the intro paragraph is gone.
    await expect(page.getByText('Surveys, sign-ups and requests')).toHaveCount(0)

    await page.getByTestId('forms-search').fill(`order ${id} lunch`)
    await expect(rows).toHaveCount(1)
    await page.getByTestId('forms-search').fill(`nothing-${id}`)
    await expect(rows).toHaveCount(0)
    await expect(page.getByTestId('forms-no-match')).toContainText('No forms match that')
    await page.getByTestId('forms-search').fill('')

    // newForm makes it in the team's space: it's under Team and not under Personal.
    const mine = rows.filter({ hasText: `Lunch order ${id}` })
    await page.getByTestId('forms-scope-mine').click()
    await expect(page).toHaveURL(/scope=mine/)
    await expect(mine).toHaveCount(0)
    await page.getByTestId('forms-scope-team').click()
    await expect(page).toHaveURL(/scope=team/)
    await expect(mine).toHaveCount(1)
    // The tab is in the address, so a reload keeps it.
    await page.reload()
    await expect(page.getByTestId('forms-scope-team')).toHaveAttribute('aria-selected', 'true')
    await page.getByTestId('forms-scope-all').click()
    await expect(page).not.toHaveURL(/scope=/)
    await expect(mine).toHaveCount(1)
  })

  for (const app of [
    {
      name: 'Forms',
      url: '/forms',
      api: '/api/forms',
      key: 'forms',
      intro: 'Surveys, sign-ups and requests',
    },
    {
      name: 'Tables',
      url: '/tables',
      api: '/api/tables',
      key: 'tables',
      intro: 'Trackers and lists',
    },
    { name: 'Pages', url: '/pages', api: '/api/pages', key: 'pages', intro: 'Plans and reports' },
    {
      name: 'Check-ins',
      url: '/checkins',
      api: '/api/checkins',
      key: 'checkins',
      intro: 'A question the team answers',
    },
  ]) {
    test(`${app.name}: the intro shows only on the empty screen`, async ({ page }) => {
      await page.route(
        (url) => url.pathname === app.api,
        async (route) => {
          const response = await route.fetch()
          await route.fulfill({ response, json: { ...(await response.json()), [app.key]: [] } })
        },
      )
      await page.goto(app.url)
      await expect(page.locator('[data-empty-state]')).toContainText(app.intro)
    })
  }

  const stamp = '2026-11-10T09:00:00.000Z'
  for (const app of [
    {
      name: 'Tables',
      url: '/tables',
      api: '/api/tables',
      key: 'tables',
      intro: 'Trackers and lists',
      items: ['Seed stock', 'Field sites'].map((title, n) => ({
        space: 'team',
        id: `t${n}`,
        title,
        updated: stamp,
        updatedBy: null,
      })),
      scoped: true,
    },
    {
      name: 'Pages',
      url: '/pages',
      api: '/api/pages',
      key: 'pages',
      intro: 'Plans and reports',
      items: ['Seed stock', 'Field sites'].map((title, n) => ({
        space: 'team',
        id: `p${n}`,
        title,
        updated: stamp,
        shared: false,
      })),
      scoped: true,
    },
    {
      name: 'Check-ins',
      url: '/checkins',
      api: '/api/checkins',
      key: 'checkins',
      intro: 'A question the team answers',
      items: ['Seed stock', 'Field sites'].map((title, n) => ({
        id: `c${n}`,
        title,
        days: ['mon'],
        time: '09:00',
        tz: 'UTC',
        schedule: 'Mondays at 9 AM',
        paused: false,
        room: null,
        skip: [],
        current: null,
      })),
      scoped: false,
    },
  ]) {
    test(`${app.name}: search filters by name, and with items there is no intro`, async ({
      page,
    }) => {
      await page.route(
        (url) => url.pathname === app.api,
        async (route) => {
          const response = await route.fetch()
          await route.fulfill({
            response,
            json: { ...(await response.json()), [app.key]: app.items },
          })
        },
      )
      await page.goto(app.url)
      const rows = page.getByTestId(`${app.key}-list`).getByRole('listitem')
      await expect(rows).toHaveCount(2)
      await expect(page.getByText(app.intro)).toHaveCount(0)
      await page.getByTestId(`${app.key}-search`).fill('STOCK seed')
      await expect(rows).toHaveText([/Seed stock/])
      await page.getByTestId(`${app.key}-search`).fill('zzz')
      await expect(rows).toHaveCount(0)
      await expect(page.getByTestId(`${app.key}-no-match`)).toContainText(
        `No ${app.name.toLowerCase()} match that`,
      )
      await page.getByTestId(`${app.key}-search`).fill('')
      await expect(rows).toHaveCount(2)
      if (!app.scoped) return
      // Both are the team's, so Personal is empty and says whose it is.
      await page.getByTestId(`${app.key}-scope-mine`).click()
      await expect(rows).toHaveCount(0)
      await expect(page.getByTestId(`${app.key}-no-match`)).toContainText(
        `No personal ${app.key} yet`,
      )
      await page.getByTestId(`${app.key}-scope-team`).click()
      await expect(rows).toHaveCount(2)
    })
  }

  test('Tasks: a list’s name is its tab, a project is named once, and search filters by name', async ({
    page,
  }) => {
    const id = uid()
    await page.goto('/tasks')
    await expect(page.getByTestId('tasks-tab-inbox')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('tasks-title')).toHaveCount(0)
    for (const title of [`Order seed ${id} #Plot${id}`, `Mend fence ${id}`]) {
      await page.getByTestId('tasks-add').click()
      const input = page.getByTestId('quick-add-input')
      await input.fill(title)
      await input.press('Enter')
      await expect(input).toBeHidden()
    }
    const rows = page.getByTestId('task-row')
    await page.getByTestId('tasks-tab-all').click()
    await expect(page).toHaveURL(/\/tasks\/all$/)
    await expect(page.getByTestId('tasks-tab-all')).toHaveAttribute('aria-selected', 'true')
    await expect(rows.filter({ hasText: id })).toHaveCount(2)
    await page.getByTestId('tasks-search').fill(`fence ${id}`)
    await expect(rows).toHaveCount(1)
    await expect(rows).toContainText(`Mend fence ${id}`)
    await page.getByTestId('tasks-search').fill(`nothing-${id}`)
    await expect(page.getByTestId('tasks-no-match')).toContainText('No tasks match that')
    // The count is of the whole list, so it steps aside while only matches show.
    await expect(page.getByTestId('tasks-count')).toHaveCount(0)

    // A task added while searching is shown, not hidden by what was typed.
    await page.getByTestId('tasks-add').click()
    const quick = page.getByTestId('quick-add-input')
    await quick.fill(`Sow beans ${id}`)
    await quick.press('Enter')
    await expect(page.getByTestId('tasks-search')).toHaveValue('')
    await expect(rows.filter({ hasText: `Sow beans ${id}` })).toHaveCount(1)
    await expect(page.getByTestId('tasks-count')).toContainText('open')

    // Each list starts unsearched.
    await page.getByTestId('tasks-search').fill(`fence ${id}`)
    await page.getByTestId('tasks-tab-done').click()
    await expect(page.getByTestId('tasks-tab-done')).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('tasks-search')).toHaveValue('')

    // A project has no tab: none is selected and the project is named, in the list heading size.
    await page
      .getByTestId('tasks-nav-project')
      .filter({ hasText: `Plot${id}` })
      .click()
    await expect(page.getByTestId('list-bar').getByRole('tab', { selected: true })).toHaveCount(0)
    const heading = page.getByTestId('tasks-title')
    await expect(heading).toHaveText(`#Plot${id}`)
    expect(
      await heading.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize)),
    ).toBeLessThanOrEqual(20)
  })

  test('Meetings: search is in the row, not the side list, and finds a meeting by name', async ({
    page,
  }) => {
    const stamp = '2026-11-10T09:00:00.000Z'
    const meeting = (title: string, n: number) => ({
      space: 'team',
      path: `meetings/2026/11/m${n}.md`,
      title,
      date: stamp,
      attendees: ['Dana Lee <dana@example.test>'],
      companies: [],
      duration_min: 30,
      hasTranscript: false,
    })
    await page.route(
      (url) => url.pathname === '/api/meetings',
      async (route) => {
        if (route.request().method() !== 'GET') return route.fallback()
        const response = await route.fetch()
        const real = (await response.json()) as object[]
        const like = real[0] ?? {}
        await route.fulfill({
          response,
          json: [
            { ...like, ...meeting('Seed stock review', 1) },
            { ...like, ...meeting('Field sites', 2) },
          ],
        })
      },
    )
    await page.goto('/meetings')
    await expect(page.getByRole('button', { name: /Search meetings and docs/ })).toHaveCount(0)
    const items = page.getByTestId('meeting-item')
    await expect(items).toHaveCount(2)
    // The top bar says Meetings once; the list of them all is not headed Meetings again.
    await expect(
      page.getByTestId('meetings-home').getByRole('heading', { name: 'Meetings', exact: true }),
    ).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'All meetings' })).toBeVisible()
    // One heading size for the sections of the page.
    const sizes = await page
      .getByTestId('meetings-home')
      .locator('h2')
      .evaluateAll((els) => [...new Set(els.map((el) => getComputedStyle(el).fontSize))])
    expect(sizes).toHaveLength(1)
    expect(Number.parseFloat(sizes[0] as string)).toBeLessThanOrEqual(20)

    await page.getByTestId('meetings-search').fill('stock')
    await expect(items).toHaveCount(1)
    await expect(items).toContainText('Seed stock review')
    // While searching, the matches are all the page shows.
    await expect(page.getByRole('heading', { name: 'Coming up' })).toHaveCount(0)
    await page.getByTestId('meetings-search').fill('dana')
    await expect(items).toHaveCount(2)
    await page.getByTestId('meetings-search').fill('zzz')
    await expect(page.getByTestId('meetings-no-match')).toContainText('No meetings match that')
    // The row looks at names and people; what was said is one press away, on a phone too.
    await page.getByTestId('meetings-search-inside').click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByTestId('meetings-search').fill('')
    await expect(page.getByRole('heading', { name: 'Coming up' })).toBeVisible()
    // The page refetches when meetings change; don't leave one of those in flight.
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })

  test('Links: Enter in the row’s search searches', async ({ page }) => {
    await page.goto('/links')
    await page.getByTestId('links-search').fill('decisions')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/q=decisions/)
  })

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 } })
    test('Files: search and the folder path are in the row', async ({ page }) => {
      await page.goto('/files')
      await expect(page.getByTestId('files-search')).toBeVisible()
      await expect(
        page.getByTestId('list-bar').getByRole('navigation', { name: 'Folder' }),
      ).toBeVisible()
    })
  })
})

// Round 4, requirements 20 to 23: the page of one thing names it once, in the top bar; its
// buttons sit there in one order (status, Share, its own, More); Delete and downloads are in
// More; one status ("Personal"/"Team" and the save chip); Settings is a pop-up.

/** The buttons in the top bar, by their words, left to right. */
async function headerButtons(page: Page): Promise<string[]> {
  return page
    .getByTestId('page-header')
    .locator('button:visible, a:visible')
    .evaluateAll((els) =>
      els
        .filter((el) => el.getAttribute('data-testid') !== 'page-back')
        .map((el) => (el.getAttribute('aria-label') || el.textContent || '').trim()),
    )
}

/** No Delete, Download, CSV or Excel button outside More. */
async function expectNothingLoose(page: Page) {
  const words = await headerButtons(page)
  expect(words.filter((w) => /^(Delete|Download|CSV|Excel)\b/.test(w))).toEqual([])
  await expect(page.locator('main button:visible', { hasText: /^Delete/ })).toHaveCount(0)
}

/** The top bar's controls sit left to right in this order, each one present. */
async function expectOrder(page: Page, testIds: string[]) {
  const bar = page.getByTestId('page-header')
  const xs: number[] = []
  for (const id of testIds) {
    const box = await bar.getByTestId(id).first().boundingBox()
    expect(box, `${id} is in the top bar`).not.toBeNull()
    xs.push(box?.x ?? 0)
  }
  expect(xs).toEqual([...xs].sort((a, b) => a - b))
}

test.describe('the page of one thing', () => {
  test('a board: its name and status in the top bar, Delete in More', async ({ page }) => {
    await page.goto('/boards')
    await page.locator('[data-main-button]').click()
    await expect(page).toHaveURL(/\/boards\/[^/]+\/.+/)
    const bar = page.getByTestId('page-header')
    await expect(bar.getByTestId('board-title')).toBeVisible()
    await expect(bar.getByTestId('item-whose')).toHaveText(/^(Personal|Team)$/)
    await expect(bar.getByTestId('board-status')).toHaveText('Saved', { timeout: 8_000 })
    await expectNothingLoose(page)
    await expectOrder(page, ['item-status', 'board-share', 'page-more'])
    await page.getByTestId('page-more').click()
    await expect(page.getByRole('menuitem', { name: 'Delete board' })).toBeVisible()
  })

  test('a table: status first, downloads and Delete in More', async ({ page }) => {
    await page.goto('/tables')
    await page.getByTestId('new-table').click()
    await page.getByTestId('new-table-in-team').click()
    const bar = page.getByTestId('page-header')
    await expect(bar.getByTestId('table-title')).toHaveValue('Untitled table')
    await expect(bar.getByTestId('item-whose')).toHaveText('Team')
    await expect(bar.getByTestId('save-status')).toHaveText('Saved', { timeout: 10_000 })
    await expectOrder(page, ['item-status', 'page-more'])
    await expectNothingLoose(page)
    await page.getByTestId('page-more').click()
    for (const name of ['Download CSV', 'Download Excel', 'Delete table'])
      await expect(page.getByRole('menuitem', { name })).toBeVisible()
  })

  test('a form: named once, the lists’ tabs, Settings as a pop-up, Delete in More', async ({
    page,
  }) => {
    await page.goto('/forms')
    const title = `One thing ${uid()}`
    await newForm(page, title)
    const bar = page.getByTestId('page-header')
    await expect(bar.getByTestId('form-title')).toHaveValue(title)
    // The name isn't repeated in the page under the top bar.
    await expect(page.locator('main input[aria-label="Form title"]')).toHaveCount(1)
    await expect(bar.getByTestId('item-whose')).toHaveText('Team')
    await expectOrder(page, [
      'item-status',
      'form-share',
      'form-open-link',
      'form-settings',
      'page-more',
    ])
    await expect(page.getByRole('tabpanel')).toBeVisible()
    await expect(page.getByTestId('list-tabs').getByRole('tab')).toHaveText([
      'Questions',
      /^Answers/,
    ])
    await expectNothingLoose(page)
    // A change shows in the status and brings a quiet Save; the red button is never a status.
    await page.getByTestId('form-description').fill('What we learned')
    await expect(bar.getByTestId('form-status')).toHaveText('Unsaved changes')
    await expect(bar.locator('[data-main-button]')).toHaveCount(0)
    await bar.getByTestId('form-save').click()
    await expect(bar.getByTestId('form-status')).toHaveText('Saved')
    await bar.getByTestId('form-settings').click()
    const dialog = page.getByTestId('form-settings-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('form-access-team')).toBeVisible()
    await page.getByTestId('dialog-x').click()
    await expect(dialog).toHaveCount(0)
    await page.getByTestId('page-more').click()
    await expect(page.getByRole('menuitem', { name: 'Delete form' })).toBeVisible()
  })

  test('a saved link: its name, Done and Share in the top bar, Delete in More', async ({
    page,
    user,
  }) => {
    const url = `https://journal.test/${uid()}/one-thing`
    const res = await page.request.post('/api/links', {
      data: { url },
      headers: { 'x-hearth-dev-user': user.email },
    })
    expect(res.status()).toBe(201)
    const { id, space } = (await res.json()) as { id: string; space: string }
    await page.goto(`/links/${encodeURIComponent(space)}/${encodeURIComponent(id)}`)
    const bar = page.getByTestId('page-header')
    await expect(bar.getByTestId('link-share')).toBeVisible()
    await expect(bar.getByTestId('link-reader-done')).toBeVisible()
    await expect(bar.locator('h1')).not.toBeEmpty()
    await expectOrder(page, ['link-share', 'link-reader-done', 'page-more'])
    await expectNothingLoose(page)
    await page.getByTestId('page-more').click()
    await expect(page.getByRole('menuitem', { name: 'Delete link' })).toBeVisible()
  })

  test('a clip’s long transcript scrolls inside the side panel, not the panel itself', async ({
    page,
  }) => {
    const now = new Date().toISOString()
    const clip = {
      id: 'long-transcript',
      title: 'A long talk',
      summary: null,
      mode: 'screen',
      status: 'ready',
      error: null,
      durationMs: 600_000,
      sizeBytes: 1,
      width: 1280,
      height: 720,
      mimeType: 'video/mp4',
      owner: { name: 'Someone', email: 'someone@example.test' },
      isOwner: false,
      createdAt: now,
      updatedAt: now,
      transcriptStatus: 'ready',
      transcriptError: null,
      compositeStatus: 'none',
      screenSurface: null,
      screenLabel: null,
      speakers: [],
      aiSummary: null,
      aiActions: null,
      editStatus: 'none',
      edited: false,
      cuts: [],
      sourceUrl: null,
      sourceDurationMs: null,
      videoUrl: null,
      thumbUrl: null,
      downloadUrl: null,
    }
    const transcript = Array.from({ length: 120 }, (_, i) => ({
      start: i * 5,
      end: i * 5 + 5,
      text: `Line ${i + 1} of a long talk`,
    }))
    await page.route('**/api/clips/long-transcript', (route) =>
      route.fulfill({ json: { clip, transcript } }),
    )
    await page.goto('/clips/long-transcript')
    const panel = page.getByTestId('clip-transcript-panel')
    await expect(panel.getByTestId('transcript-line')).toHaveCount(120)
    const scroll = await panel.evaluate((aside) => {
      const list = aside.querySelector('[data-testid="clip-transcript"]') as HTMLElement
      const body = list.closest('.clip-side')?.parentElement as HTMLElement
      return {
        list: list.scrollHeight > list.clientHeight + 10,
        body: body.scrollHeight <= body.clientHeight + 1,
      }
    })
    expect(scroll).toEqual({ list: true, body: true })
  })

  test('a form and a saved link read at a doc’s width', async ({ page, user }) => {
    const measure = await page.evaluate(() => {
      const probe = document.createElement('div')
      probe.style.width = 'var(--measure)'
      document.body.append(probe)
      const width = probe.getBoundingClientRect().width
      probe.remove()
      return width
    })
    expect(measure).toBeGreaterThan(600)
    const widths = async () =>
      page
        .locator('[data-item-width="reading"]')
        .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)))

    await page.goto('/forms')
    await newForm(page, `Width ${uid()}`)
    await expect.poll(widths).toEqual(expect.arrayContaining([Math.round(measure)]))
    expect((await widths()).every((w) => w === Math.round(measure))).toBe(true)

    const res = await page.request.post('/api/links', {
      data: { url: `https://journal.test/${uid()}/width` },
      headers: { 'x-hearth-dev-user': user.email },
    })
    const { id, space } = (await res.json()) as { id: string; space: string }
    await page.goto(`/links/${encodeURIComponent(space)}/${encodeURIComponent(id)}`)
    await expect(page.getByTestId('link-share')).toBeVisible()
    await expect.poll(widths).toEqual(expect.arrayContaining([Math.round(measure)]))
    expect((await widths()).every((w) => w === Math.round(measure))).toBe(true)
  })
})
