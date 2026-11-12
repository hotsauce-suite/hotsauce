import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  type APIRequestContext,
  type APIResponse,
  test as base,
  expect,
  type Locator,
  type Page,
  type Response,
} from '@playwright/test'

export { expect }

const run = promisify(execFile)

// Shapes from docs/ARCHITECTURE.md §3 that the specs read.
export interface Space {
  name: string
  kind: 'team' | 'personal'
  label: string
}
export interface Principal {
  userId: string
  email: string
  name: string
  handle: string
  isAdmin: boolean
}
export interface Commit {
  oid: string
  author: { name: string; email: string }
  date: string
  message: string
  label?: string
}
export type SaveState = 'dirty' | 'saving' | 'saved' | 'committed' | 'conflict'

/** The member a worker signs in as. Space names come from GET /api/me. */
export interface E2EUser {
  email: string
  name: string
  handle: string
  team: string
  personal: string
}

/** Thin client for the Hearth API, authenticated as `email` via the dev-auth header. */
export class HearthApi {
  constructor(
    private readonly request: APIRequestContext,
    readonly email: string,
  ) {}

  async me(): Promise<{ principal: Principal; spaces: Space[] }> {
    return (await ok(await this.request.get('/api/me'))).json()
  }

  /** Creates or overwrites a file with one commit, the way a client save does. */
  async writeFile(space: string, file: string, content: string): Promise<void> {
    await ok(await this.request.put(spaceUrl(space, 'file'), { data: { path: file, content } }))
  }

  /** The file at HEAD, or null when it doesn't exist. */
  async readFile(
    space: string,
    file: string,
  ): Promise<{ content: string; blobOid: string } | null> {
    const res = await this.request.get(spaceUrl(space, 'file'), { params: { path: file } })
    if (res.status() === 404) return null
    return (await ok(res)).json()
  }

  async history(space: string, file: string): Promise<Commit[]> {
    const res = await this.request.get(spaceUrl(space, 'history'), { params: { path: file } })
    return (await ok(res)).json()
  }

  async move(space: string, from: string, to: string): Promise<void> {
    await ok(await this.request.post(spaceUrl(space, 'move'), { data: { from, to } }))
  }

  async conflicts(space: string): Promise<Array<{ ref: string; path: string; createdAt: string }>> {
    return (await ok(await this.request.get(spaceUrl(space, 'conflicts')))).json()
  }
}

async function ok(res: APIResponse): Promise<APIResponse> {
  if (!res.ok()) {
    throw new Error(`${res.status()} from ${res.url()}: ${await res.text()}`)
  }
  return res
}

function spaceUrl(space: string, route: string): string {
  return `/api/spaces/${encodeURIComponent(space)}/${route}`
}

// "Outside" edits (Obsidian, an agent, a script) commit as this identity. The
// global and system git config are ignored so a developer's signing or hooks
// settings can't change what the tests do.
const OUTSIDE_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Outside Editor',
  GIT_AUTHOR_EMAIL: 'outside@example.test',
  GIT_COMMITTER_NAME: 'Outside Editor',
  GIT_COMMITTER_EMAIL: 'outside@example.test',
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, env: OUTSIDE_GIT_ENV })
  return stdout.trim()
}

/** A clone of a space's bare remote in a temp dir, for simulating pushes from outside Hearth. */
export class Checkout {
  constructor(readonly dir: string) {}

  read(file: string): Promise<string> {
    return readFile(path.join(this.dir, file), 'utf8')
  }

  async write(file: string, content: string): Promise<void> {
    const full = path.join(this.dir, file)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, content)
  }

  /** Rewrites a file; throws if `change` leaves it untouched, so a stale search string fails loudly. */
  async edit(file: string, change: (text: string) => string): Promise<void> {
    const before = await this.read(file)
    const after = change(before)
    if (after === before) throw new Error(`edit of ${file} changed nothing`)
    await this.write(file, after)
  }

  async pull(): Promise<void> {
    await git(this.dir, 'pull', '--quiet', '--rebase', 'origin', 'main')
  }

  /** Commits everything as Outside Editor and pushes to main. Returns the pushed commit's oid. */
  async commitAndPush(message: string): Promise<string> {
    await git(this.dir, 'add', '-A')
    await git(this.dir, 'commit', '--quiet', '-m', message)
    // Other workers' saves push to the same remote; replay on top and retry.
    for (let attempt = 1; ; attempt++) {
      try {
        await git(this.dir, 'push', '--quiet', 'origin', 'HEAD:main')
        break
      } catch (err) {
        if (attempt === 5) throw err
        await this.pull()
      }
    }
    return git(this.dir, 'rev-parse', 'HEAD')
  }
}

export interface Remote {
  /** Clones `<LOCAL_HOST_DIR>/<repo>.git`; `repo` is "team" or a member's handle. */
  clone(repo: string): Promise<Checkout>
}

type WaitForState = (
  testId: string,
  state: SaveState,
  options?: { timeout?: number },
) => Promise<void>

export interface TestFixtures {
  /** Sign the page in through the dev form before the test. Turn off to test sign-in itself. */
  signedIn: boolean
  remote: Remote
  waitForState: WaitForState
}

export interface WorkerFixtures {
  api: HearthApi
  user: E2EUser
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  // One member per worker, unique per run so a reused local server doesn't mix runs.
  api: [
    async ({ playwright }, use, workerInfo) => {
      const { baseURL } = workerInfo.project.use
      if (!baseURL) throw new Error('baseURL is not set in playwright.config.ts')
      const email = `e2e-w${workerInfo.workerIndex}-${Date.now().toString(36)}@example.test`
      const request = await playwright.request.newContext({
        baseURL,
        extraHTTPHeaders: { 'x-hearth-dev-user': email },
      })
      await use(new HearthApi(request, email))
      await request.dispose()
    },
    { scope: 'worker' },
  ],

  user: [
    async ({ api }, use) => {
      // The first authenticated request also provisions the personal space.
      const { principal, spaces } = await api.me()
      const team = spaces.find((s) => s.kind === 'team')
      const personal = spaces.find((s) => s.kind === 'personal')
      if (!team || !personal) throw new Error(`/api/me returned spaces ${JSON.stringify(spaces)}`)
      await use({
        email: api.email,
        name: principal.name,
        handle: principal.handle,
        team: team.name,
        personal: personal.name,
      })
    },
    { scope: 'worker' },
  ],

  signedIn: [true, { option: true }],

  page: async ({ page, user, signedIn }, use) => {
    if (signedIn) await signIn(page, user.email)
    await use(page)
  },

  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture dependencies from this pattern.
  remote: async ({}, use) => {
    const localHostDir = process.env.HEARTH_E2E_LOCAL_HOST_DIR
    if (!localHostDir)
      throw new Error('HEARTH_E2E_LOCAL_HOST_DIR is unset; run via playwright.config.ts')
    const dirs: string[] = []
    await use({
      async clone(repo) {
        const bare = path.join(localHostDir, `${repo}.git`)
        if (!existsSync(bare)) {
          throw new Error(
            `No bare repo at ${bare}. If a server from another run is still on :3999, stop it; ` +
              'set CI=1 to never reuse one.',
          )
        }
        const dir = await mkdtemp(path.join(os.tmpdir(), 'hearth-e2e-outside-'))
        dirs.push(dir)
        await git(dir, 'clone', '--quiet', '--branch', 'main', `file://${bare}`, '.')
        return new Checkout(dir)
      },
    })
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  },

  waitForState: async ({ page }, use) => {
    await use(async (testId, state, options) => {
      await expect(page.getByTestId(testId)).toHaveAttribute('data-state', state, options)
    })
  },
})

/** Signs in through the dev form (AUTH_MODE=dev) and waits to leave /sign-in. */
export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/sign-in')
  await page.getByTestId('dev-signin-email').fill(email)
  await page.getByTestId('dev-signin-submit').click()
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'))
}

/** A short, lowercase, slug-safe token that keeps test docs apart across workers and runs. */
export function uid(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** The web route for a file: /docs/:space/<path>. */
export function docUrl(space: string, file: string): string {
  return `/docs/${encodeURIComponent(space)}/${file.split('/').map(encodeURIComponent).join('/')}`
}

/** Matches the page URL against a doc route, ignoring any query or hash. */
export function isDocUrl(space: string, file: string): (url: URL) => boolean {
  return (url) => url.pathname === docUrl(space, file)
}

/** Splits the current /docs/:space/<path> URL back into space and path. */
export function parseDocUrl(url: string): { space: string; path: string } {
  const match = new URL(url).pathname.match(/^\/docs\/([^/]+)\/(.+)$/)
  if (!match?.[1] || !match[2]) throw new Error(`not a doc URL: ${url}`)
  return {
    space: decodeURIComponent(match[1]),
    path: match[2].split('/').map(decodeURIComponent).join('/'),
  }
}

export function treeItem(page: Page, file: string): Locator {
  return page.locator(`[data-testid="tree-item"][data-path="${file}"]`)
}

/**
 * Expands every folder above `file` in the lazily loaded tree. Folder items
 * carry aria-expanded. A tree rooted at docs/ has no item for "docs" itself.
 */
export async function expandTreeTo(page: Page, file: string): Promise<void> {
  await expect(page.getByTestId('tree-item').first()).toBeVisible()
  const parts = file.split('/')
  for (let depth = 1; depth < parts.length; depth++) {
    const folder = treeItem(page, parts.slice(0, depth).join('/'))
    if (depth === 1 && (await folder.count()) === 0) continue
    // The app may also expand toward the open doc on its own; converge rather than toggle blindly.
    await expect(async () => {
      if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.click()
      await expect(folder).toHaveAttribute('aria-expanded', 'true', { timeout: 1_000 })
    }).toPass({ timeout: 5_000 })
  }
}

/** The open document's text, in whichever of the editor or the reading view is showing. */
export function docText(page: Page): Locator {
  return page.getByTestId('editor-content').or(page.getByTestId('reading-view')).first()
}

/** Moves the cursor to the end of the focused editor and types `text` as a new paragraph. */
export async function typeAtEnd(page: Page, text: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type(text)
}

/** Clicks the editor line containing `lineText` and replaces the whole line. */
export async function replaceLine(
  page: Page,
  lineText: string,
  replacement: string,
): Promise<void> {
  await page.getByTestId('editor-content').getByText(lineText).click()
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
  await page.keyboard.type(replacement)
}

function isFileSave(response: Response): boolean {
  const { pathname } = new URL(response.url())
  return (
    response.request().method() === 'PUT' &&
    pathname.startsWith('/api/spaces/') &&
    pathname.endsWith('/file')
  )
}

/**
 * Resolves with the client's save (PUT /api/spaces/:space/file) whose body contains
 * `containing`. Start waiting before the edit that triggers it.
 */
export function waitForSave(page: Page, containing: string, timeout = 3_000): Promise<Response> {
  return page.waitForResponse(
    (r) => isFileSave(r) && (r.request().postData() ?? '').includes(containing),
    { timeout },
  )
}

/**
 * Holds the page's next save until `during` has run, so the server receives an
 * edit whose base is stale (as when someone pushes while you type).
 */
export async function holdNextSave(page: Page, during: () => Promise<void>): Promise<void> {
  let held = false
  await page.route(
    (url) => url.pathname.startsWith('/api/spaces/') && url.pathname.endsWith('/file'),
    async (route) => {
      if (held || route.request().method() !== 'PUT') return route.fallback()
      held = true
      try {
        await during()
      } finally {
        await route.continue()
      }
    },
  )
}

/**
 * Presses Cmd-K until the palette opens. The shell listens for it in an effect, just after it
 * paints; under load a press that lands in between is lost.
 */
export async function pressCommandK(page: Page): Promise<void> {
  await expect(async () => {
    if (!(await page.getByTestId('cmdk').isVisible())) await page.keyboard.press('ControlOrMeta+K')
    await expect(page.getByTestId('cmdk')).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 8_000 })
}
