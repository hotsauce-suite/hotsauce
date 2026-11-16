import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { loadConfig } from '../../src/config.js'
import { runGit } from '../../src/git/index.js'
import {
  type FetchKind,
  fakePageFetcher,
  fakePaperPdf,
  LinkFetchError,
  type LinkView,
} from '../../src/links/index.js'
import { makeTestPdf } from '../../src/links/test-pdf.js'
import { FakeLLM, scriptedResponse } from '../../src/meetings/index.js'
import { createServices, type Services } from '../../src/services.js'
import { makeTempDir, removeDir } from '../helpers/git.js'

// PDFs and papers in saved links (docs/PLAN-links-pdfs.md) through the API, with the stand-in
// fetcher's PDFs and arXiv, bioRxiv and medRxiv answers.

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'

let root: string
let services: Services
let app: ReturnType<typeof createApp>
let fetched: string[]
/** Addresses that fail while listed. */
let failing: RegExp | null = null

beforeEach(async () => {
  root = await makeTempDir('hotsauce-link-pdfs-')
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'dev',
    HOST_KIND: 'local',
    DATA_DIR: join(root, 'data'),
    LOCAL_HOST_DIR: join(root, 'remotes'),
    ALLOWED_EMAIL_DOMAINS: 'example.test',
    PUBLIC_URL: 'https://hotsauce.example.test',
  })
  fetched = []
  failing = null
  services = createServices(config, {
    llm: new FakeLLM(scriptedResponse),
    linkFetch: async (url: string, kind?: FetchKind) => {
      fetched.push(url)
      if (failing?.test(url)) throw new LinkFetchError('Couldn’t reach the site')
      return fakePageFetcher(url, kind)
    },
  })
  await services.spaces.ensureTeamSpace()
  app = createApp(services)
  await call('GET', '/api/me', { as: ALICE })
  await call('GET', '/api/me', { as: BOB })
})

afterEach(async () => {
  await services.links.idle()
  services.index.close()
  services.dictation.store.close()
  await removeDir(root)
})

interface Options {
  as?: string
  token?: string
  json?: unknown
}

async function call(method: string, url: string, opts: Options = {}): Promise<Response> {
  const headers: Record<string, string> = {}
  if (opts.as) headers['x-hearth-dev-user'] = opts.as
  if (opts.token) headers.authorization = `Bearer ${opts.token}`
  if (opts.json !== undefined) headers['content-type'] = 'application/json'
  return app.request(url, {
    method,
    headers,
    ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
  })
}

// biome-ignore lint/suspicious/noExplicitAny: response shapes are checked by the assertions
async function api<T = any>(
  method: string,
  url: string,
  opts: Options & { status?: number } = {},
): Promise<T> {
  const res = await call(method, url, { as: ALICE, ...opts })
  const text = await res.text()
  expect(res.status, `${method} ${url} → ${text}`).toBe(opts.status ?? 200)
  return (text ? JSON.parse(text) : null) as T
}

async function save(url: string, opts: Options & { status?: number } = {}) {
  const link = await api<LinkView>('POST', '/api/links', { status: 201, json: { url }, ...opts })
  await services.links.idle()
  return api<LinkView & { body: string }>('GET', `/api/links/${link.space}/${link.id}`, opts)
}

/** What the member's Files hold in a space. */
async function filesIn(space: string, as = ALICE) {
  const res = await api('GET', `/api/files?space=${space}&folder=Links`, { as })
  return res.files as Array<{ id: string; name: string; folder: string }>
}

/** Uploads bytes to Files the way the web does, as the member. */
async function upload(space: string, name: string, bytes: Uint8Array, as = ALICE) {
  const who = { name: as.split('@')[0] ?? as, email: as }
  return services.files.storeFormFile(who, { space, folder: 'Links', name, bytes })
}

describe('a PDF at a web address (R3)', () => {
  it('keeps the PDF in Files under Links and makes its text the copy', async () => {
    const link = await save('https://papers.pdf.test/files/mirror-bacteria.pdf')
    expect(link).toMatchObject({
      status: 'ready',
      title: 'Mirror bacteria',
      site: 'papers.pdf.test',
    })
    expect(link.body).toContain('## 1 Introduction')
    expect(link.body).toContain('The introduction sentence 1 says something worth reading.')
    expect(link.body).not.toMatch(/^2$/m)
    expect(link.words).toBeGreaterThan(50)
    const files = await filesIn('alice')
    expect(files).toEqual([
      expect.objectContaining({ id: link.file, name: 'Mirror bacteria.pdf', folder: 'Links' }),
    ])
  })

  it('keeps a scanned PDF with no text, and the link says so by having no words', async () => {
    const link = await save('https://scanned.pdf.test/scan.pdf')
    expect(link.status).toBe('ready')
    expect(link.body).toBe('')
    expect(link.words).toBeNull()
    expect(link.file).toMatch(/^[0-9A-Z]{26}$/)
  })

  it('R8: reading it again keeps one PDF when nothing changed', async () => {
    const link = await save('https://papers.pdf.test/again.pdf')
    await api('POST', `/api/links/alice/${link.id}/refetch`)
    await services.links.idle()
    const after = await api('GET', `/api/links/alice/${link.id}`)
    expect(after.file).toBe(link.file)
    expect(await filesIn('alice')).toHaveLength(1)
  })

  it('R7: Share with team moves the PDF too, and Delete trashes it', async () => {
    const link = await save('https://papers.pdf.test/shared.pdf')
    const shared = await api('POST', `/api/links/alice/${link.id}/move`, {
      json: { toSpace: 'team' },
    })
    expect(shared.file).toBe(link.file)
    expect(await filesIn('alice')).toEqual([])
    expect(await filesIn('team', BOB)).toEqual([
      expect.objectContaining({ id: link.file, folder: 'Links' }),
    ])
    // Bob can open the PDF; Alice takes the link back and the PDF comes along.
    await api('GET', `/api/files/item/team/${link.file}`, { as: BOB })
    await api('POST', `/api/links/team/${link.id}/move`, { json: { toSpace: 'alice' } })
    expect(await filesIn('alice')).toHaveLength(1)
    await api('DELETE', `/api/links/alice/${link.id}`, { status: 204 })
    expect(await filesIn('alice')).toEqual([])
  })
})

describe('arXiv (R2, R4, R9)', () => {
  it('reads the details from the API, the web version as the copy, and keeps the PDF', async () => {
    const link = await save('https://arxiv.org/abs/2401.00001')
    expect(link).toMatchObject({
      title: 'A stand-in paper 2401.00001',
      site: 'arxiv.org',
      summary: 'We show that stand-in papers can be read. 2401.00001 is about testing.',
      paper: {
        server: 'arxiv',
        id: '2401.00001',
        version: 2,
        authors: ['Ada Lovelace', 'Alan Turing', 'Grace Hopper', 'Katherine Johnson'],
        published: '2024-01-15',
        doi: '10.1000/fake.2401.00001',
      },
    })
    expect(link.body).toContain('## 1 Introduction')
    // Formulas read as their TeX, once.
    expect(link.body).toContain('goes on with x\\_{0} in it')
    expect(fetched).toEqual(
      ['https://arxiv.org/abs/2401.00001']
        .slice(0, 0)
        .concat([
          'https://export.arxiv.org/api/query?id_list=2401.00001',
          'https://arxiv.org/html/2401.00001v2',
          'https://arxiv.org/pdf/2401.00001v2',
        ]),
    )
    expect(await filesIn('alice')).toEqual([
      expect.objectContaining({ id: link.file, name: 'A stand-in paper 2401.00001.pdf' }),
    ])
  })

  it('reads the PDF when arXiv has no web version', async () => {
    const link = await save('https://arxiv.org/pdf/2401.00002v1')
    expect(link.paper?.version).toBe(1)
    expect(link.body).toContain('The results sentence 1 says something worth reading.')
    expect(link.file).toBeTruthy()
  })

  it('Q5: every address of a saved paper finds the same link', async () => {
    const link = await save('https://arxiv.org/abs/2401.00003')
    for (const url of [
      'https://arxiv.org/pdf/2401.00003v2',
      'https://arxiv.org/html/2401.00003',
      'http://www.arxiv.org/abs/2401.00003v1',
    ]) {
      const again = await api('POST', '/api/links', { json: { url } })
      expect(again).toMatchObject({ id: link.id, existing: true })
    }
  })

  it('says so when arXiv doesn’t know the paper', async () => {
    const link = await save('https://arxiv.org/abs/0000.00000')
    expect(link).toMatchObject({ status: 'failed', fetchError: 'arXiv doesn’t know that paper' })
  })

  it('search finds a paper by its authors and abstract (R12)', async () => {
    const link = await save('https://arxiv.org/abs/2401.00004')
    const byAuthor = await api('GET', '/api/links?view=all&q=Hopper')
    expect(byAuthor.links.map((l: LinkView) => l.id)).toEqual([link.id])
  })
})

describe('bioRxiv and medRxiv (R5)', () => {
  it('reads the details and the full text, never the site’s pages, and keeps no PDF', async () => {
    const link = await save('https://www.biorxiv.org/content/10.1101/2024.02.01.123456v1')
    expect(link).toMatchObject({
      status: 'ready',
      title: 'A stand-in paper 10.1101/2024.02.01.123456 (version 1)',
      site: 'biorxiv.org',
      file: null,
      paper: {
        server: 'biorxiv',
        version: 1,
        authors: ['A. Lovelace', 'A. M. Turing'],
        published: '2024-02-01',
      },
    })
    expect(link.body).toContain('## Introduction')
    expect(link.body).toContain('### A finding')
    expect(link.body).toContain('- First point')
    expect(link.body).toContain('*Figure 1. A figure caption.*')
    expect(link.body).not.toContain('reference that is left out')
    expect(fetched.some((u) => u.includes('/content/10.1101'))).toBe(false)
  })

  it('keeps the details when the full text can’t be had', async () => {
    failing = /source\.xml/
    const link = await save('https://www.medrxiv.org/content/10.1101/2024.02.01.999999v2.full.pdf')
    expect(link).toMatchObject({
      status: 'ready',
      body: '',
      summary: 'We show that preprints can be read from their full text.',
      paper: { server: 'medrxiv', version: 2 },
    })
  })

  it('R6: Add the PDF puts an uploaded PDF on the paper', async () => {
    const link = await save('https://www.biorxiv.org/content/10.1101/2024.02.01.555555v1')
    const stored = await upload('alice', 'paper.pdf', fakePaperPdf('Preprint'))
    const after = await api('POST', `/api/links/alice/${link.id}/pdf`, {
      json: { file: stored.id },
    })
    expect(after.file).toBe(stored.id)
    // The full text had more words, so it stays the copy.
    const got = await api('GET', `/api/links/alice/${link.id}`)
    expect(got.body).toContain('## Introduction')
    await api('POST', `/api/links/alice/${link.id}/pdf`, {
      json: { file: stored.id },
      status: 409,
    })
  })
})

describe('a PDF from the computer (R6)', () => {
  it('saves an uploaded PDF as a link with no address, read from the file', async () => {
    const stored = await upload('alice', 'Field notes.pdf', fakePaperPdf('Field notes on mirrors'))
    const link = await api('POST', '/api/links/pdf', {
      json: { space: 'alice', file: stored.id },
      status: 201,
    })
    expect(link).toMatchObject({ url: '', file: stored.id, title: 'Field notes' })
    await services.links.idle()
    const got = await api('GET', `/api/links/alice/${link.id}`)
    // Named after the file until the read finds the PDF's own title.
    expect(got).toMatchObject({ status: 'ready', title: 'Field notes on mirrors' })
    expect(got.body).toContain('The abstract sentence 1')
    // Saving the same file again finds the link.
    const again = await api('POST', '/api/links/pdf', { json: { space: 'alice', file: stored.id } })
    expect(again).toMatchObject({ id: link.id, existing: true })
    // R8: Get the page again reads the kept file.
    await api('POST', `/api/links/alice/${link.id}/refetch`)
    await services.links.idle()
    expect((await api('GET', `/api/links/alice/${link.id}`)).status).toBe('ready')
    expect(fetched).toEqual([])
    // A title the member gave it survives a later read.
    await api('PATCH', `/api/links/alice/${link.id}`, { json: { title: 'My notes' } })
    await api('POST', `/api/links/alice/${link.id}/refetch`)
    await services.links.idle()
    expect((await api('GET', `/api/links/alice/${link.id}`)).title).toBe('My notes')
  })

  it('refuses what isn’t a PDF, another member’s file, and access tokens', async () => {
    const text = await upload('alice', 'notes.pdf', new TextEncoder().encode('just words'))
    await api('POST', '/api/links/pdf', {
      json: { space: 'alice', file: text.id },
      status: 400,
    })
    const pdf = await upload('alice', 'mine.pdf', makeTestPdf([['Mine']]))
    await api('POST', '/api/links/pdf', {
      as: BOB,
      json: { space: 'alice', file: pdf.id },
      status: 403,
    })
    const token = await api('POST', '/api/tokens', { json: { name: 'script' }, status: 201 })
    const res = await call('POST', '/api/links/pdf', {
      token: token.token,
      json: { space: 'alice', file: pdf.id },
    })
    expect(res.status).toBe(403)
  })
})

describe('commits', () => {
  it('authors the PDF and the link as the member', async () => {
    await save('https://papers.pdf.test/authored.pdf')
    const out = await runGit(join(root, 'remotes', 'alice.git'), [
      'log',
      '-3',
      '--format=%an|%s',
      'main',
    ])
    expect(out.trim().split('\n')).toEqual([
      'Alice|links: read "Authored"',
      'Alice|files: upload "Authored.pdf"',
      'Alice|links: save "https://papers.pdf.test/authored.pdf"',
    ])
  })
})
