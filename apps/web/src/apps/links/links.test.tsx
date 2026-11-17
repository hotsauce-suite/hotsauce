import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinkHighlight, LinkView, LinkWithBody } from '../../api/links'
import { server } from '../../test/mockServer'
import { renderApp } from '../../test/renderApp'
import { forgetRecentPlaces } from './useReadingPlace'

afterEach(cleanup)

let store: LinkWithBody[]
let posted: Array<Record<string, unknown>>
let places: Array<{ id: string; space: string; json: unknown }>

function link(over: Partial<LinkWithBody>): LinkWithBody {
  return {
    space: 'ada',
    path: `links/${over.id}.md`,
    id: '01JC0000000000000000000001',
    blobOid: 'b',
    url: 'https://journal.test/mirror',
    title: 'Mirror life, explained',
    site: 'The Journal',
    description: '',
    summary: 'Why mirror bacteria worry biologists.',
    tags: ['biosecurity'],
    archived: false,
    saved: '2026-11-12T10:00:00Z',
    savedBy: 'ada@example.test',
    fetched: '2026-11-12T10:00:05Z',
    fetchError: null,
    words: 1200,
    source: 'web',
    status: 'ready',
    reading: null,
    highlightCount: 0,
    file: null,
    paper: null,
    highlights: [],
    body: '## Why it matters\n\nSee [the paper](https://journal.test/p). ![fig](https://journal.test/f.png)',
    ...over,
  }
}

beforeEach(() => {
  store = [
    link({ id: '01JC0000000000000000000001' }),
    link({
      id: '01JC0000000000000000000002',
      title: 'Gene drives',
      url: 'https://b.test/gd',
      site: 'b.test',
      tags: ['ecology'],
      saved: '2026-11-11T10:00:00Z',
      status: 'failed',
      fetchError: 'Couldn’t reach the site',
      summary: '',
    }),
    link({ id: '01JC0000000000000000000003', title: 'Old read', archived: true }),
  ]
  posted = []
  places = []
  forgetRecentPlaces()
  const strip = ({ body: _b, ...rest }: LinkWithBody): LinkView => rest
  server.use(
    http.get('/api/links', ({ request }) => {
      const url = new URL(request.url)
      const archive = url.searchParams.get('view') === 'archive'
      const tag = url.searchParams.get('tag')
      return HttpResponse.json({
        links: store
          .filter((l) => l.archived === archive)
          .filter((l) => !tag || l.tags.includes(tag))
          .map(strip),
      })
    }),
    http.get('/api/links/tags', () =>
      HttpResponse.json([
        { name: 'biosecurity', count: 2 },
        { name: 'ecology', count: 1 },
      ]),
    ),
    http.post('/api/links', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>
      posted.push(body)
      const url = String(body.url ?? /https?:\/\/\S+/.exec(String(body.text ?? ''))?.[0] ?? '')
      const existing = store.find((l) => l.url === url)
      if (existing) return HttpResponse.json({ ...strip(existing), existing: true })
      const made = link({
        id: `01JC00000000000000000000${String(store.length + 10).padStart(2, '0')}`,
        url,
        title: String(body.title ?? ''),
        status: 'fetching',
        summary: '',
        tags: [],
        body: '',
      })
      store.unshift(made)
      return HttpResponse.json({ ...strip(made), existing: false }, { status: 201 })
    }),
    http.get('/api/links/:space/:id', ({ params }) => {
      const l = store.find((x) => x.id === params.id)
      return l
        ? HttpResponse.json(l)
        : HttpResponse.json({ error: { code: 'not_found', message: 'No link' } }, { status: 404 })
    }),
    http.put('/api/links/:space/:id/reading', async ({ params, request }) => {
      places.push({
        id: String(params.id),
        space: String(params.space),
        json: await request.json(),
      })
      return new HttpResponse(null, { status: 204 })
    }),
    http.post('/api/links/:space/:id/move', async ({ params, request }) => {
      const l = store.find((x) => x.id === params.id) as LinkWithBody
      l.space = String(((await request.json()) as { toSpace: string }).toSpace)
      return HttpResponse.json(strip(l))
    }),
    http.post('/api/links/:space/:id/highlights', async ({ params, request }) => {
      const body = (await request.json()) as Record<string, unknown>
      posted.push({ highlight: body })
      const made = {
        id: `H${posted.length}`,
        by: 'ada@example.test',
        at: '2026-11-16T10:00:00Z',
        name: 'Ada',
        ...body,
      } as LinkHighlight
      const l = store.find((x) => x.id === params.id) as LinkWithBody
      l.highlights = [...l.highlights, made]
      return HttpResponse.json(made, { status: 201 })
    }),
    http.patch('/api/links/:space/:id/highlights/:hid', async ({ params, request }) => {
      const { note } = (await request.json()) as { note: string }
      posted.push({ note, hid: params.hid })
      const l = store.find((x) => x.id === params.id) as LinkWithBody
      const h = l.highlights.find((x) => x.id === params.hid) as LinkHighlight
      Object.assign(h, { note })
      return HttpResponse.json(h)
    }),
    http.delete('/api/links/:space/:id/highlights/:hid', ({ params }) => {
      posted.push({ removed: params.hid })
      return new HttpResponse(null, { status: 204 })
    }),
    http.post('/api/links/:space/:id/highlights/doc', () => {
      posted.push({ copied: true })
      return HttpResponse.json(
        { space: 'ada', path: 'docs/highlights-mirror-life.md', title: 'Highlights: Mirror life' },
        { status: 201 },
      )
    }),
    http.get('/api/links/highlights', () =>
      HttpResponse.json({
        highlights: store.flatMap((l) =>
          l.highlights.map((h) => ({
            ...h,
            link: { space: l.space, id: l.id, title: l.title, site: l.site, url: l.url },
          })),
        ),
      }),
    ),
    http.patch('/api/links/:space/:id', async ({ params, request }) => {
      const l = store.find((x) => x.id === params.id) as LinkWithBody
      Object.assign(l, (await request.json()) as object)
      return HttpResponse.json(strip(l))
    }),
  )
})

describe('the list', () => {
  it('shows Unread with summaries, failures, tags, and filters by tag', async () => {
    const user = userEvent.setup()
    renderApp('/links')
    await waitFor(() => expect(screen.getAllByTestId('link-row')).toHaveLength(2))
    expect(screen.getAllByTestId('link-title').map((e) => e.textContent)).toEqual([
      'Mirror life, explained',
      'Gene drives',
    ])
    expect(screen.getByText('Why mirror bacteria worry biologists.')).toBeInTheDocument()
    expect(screen.getByTestId('link-failed')).toHaveTextContent('Couldn’t reach the site')
    expect(screen.getByText(/The Journal · 5 min read/)).toBeInTheDocument()
    await user.click(screen.getAllByTestId('links-tag')[1] as HTMLElement)
    await waitFor(() =>
      expect(screen.getAllByTestId('link-title').map((e) => e.textContent)).toEqual([
        'Gene drives',
      ]),
    )
  })

  it('saves a pasted link and marks one done', async () => {
    const user = userEvent.setup()
    renderApp('/links')
    await waitFor(() => expect(screen.getAllByTestId('link-row')).toHaveLength(2))
    await user.type(screen.getByTestId('links-paste'), 'https://new.test/a-read')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getAllByTestId('link-row')).toHaveLength(3))
    expect(posted).toEqual([{ url: 'https://new.test/a-read', source: 'web' }])
    expect(screen.getByTestId('link-fetching')).toBeInTheDocument()
    await user.click(screen.getAllByTestId('link-done')[1] as HTMLElement)
    await waitFor(() => expect(screen.getAllByTestId('link-row')).toHaveLength(2))
    expect(store.find((l) => l.title === 'Mirror life, explained')?.archived).toBe(true)
  })

  it('shows Archive', async () => {
    const user = userEvent.setup()
    renderApp('/links')
    await waitFor(() => expect(screen.getAllByTestId('link-row')).toHaveLength(2))
    await user.click(screen.getByTestId('links-view-archive'))
    await waitFor(() =>
      expect(screen.getAllByTestId('link-title').map((e) => e.textContent)).toEqual(['Old read']),
    )
  })
})

describe('the reader', () => {
  it('shows the readable copy with links opening outside and no pictures loaded', async () => {
    renderApp('/links/ada/01JC0000000000000000000001')
    await waitFor(() => expect(screen.getByTestId('link-body')).toBeInTheDocument())
    expect(screen.getByTestId('link-reader-title')).toHaveTextContent('Mirror life, explained')
    expect(screen.getByTestId('link-original')).toHaveAttribute(
      'href',
      'https://journal.test/mirror',
    )
    const paper = screen.getByRole('link', { name: 'the paper' })
    expect(paper).toHaveAttribute('target', '_blank')
    expect(screen.getByTestId('link-body').querySelector('img')).toBeNull()
    expect(screen.getByRole('link', { name: 'Picture: fig' })).toHaveAttribute(
      'href',
      'https://journal.test/f.png',
    )
  })

  it('offers a fresh read when only part of the page came through, and not otherwise', async () => {
    const user = userEvent.setup()
    store[0] = link({
      id: '01JC0000000000000000000001',
      words: 3,
      body: '[EA Forum](https://x.test/)',
    })
    let refetched = 0
    server.use(
      http.post('/api/links/:space/:id/refetch', () => {
        refetched++
        const { body: _b, ...rest } = store[0] as LinkWithBody
        return HttpResponse.json({ ...rest, status: 'fetching' })
      }),
    )
    renderApp('/links/ada/01JC0000000000000000000001')
    await waitFor(() => expect(screen.getByTestId('link-short')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Get the page again' }))
    await waitFor(() => expect(refetched).toBe(1))
    await waitFor(() => expect(screen.getByTestId('link-fetching')).toBeInTheDocument())
    cleanup()
    store[0] = link({ id: '01JC0000000000000000000001' })
    renderApp('/links/ada/01JC0000000000000000000001')
    await waitFor(() => expect(screen.getByTestId('link-body')).toBeInTheDocument())
    expect(screen.queryByTestId('link-short')).toBeNull()
    cleanup()
    store[0] = link({ id: '01JC0000000000000000000001', words: null })
    renderApp('/links/ada/01JC0000000000000000000001')
    await waitFor(() => expect(screen.getByTestId('link-body')).toBeInTheDocument())
    expect(screen.queryByTestId('link-short')).toBeNull()
  })

  it('R6: shows a link an AI tool saved with its address, and gets it only on a click', async () => {
    const user = userEvent.setup()
    const waiting = {
      id: '01JC0000000000000000000001',
      url: 'https://attacker.test/collect?q=plans',
      source: 'mcp' as const,
      status: 'waiting' as const,
      fetched: null,
      words: null,
      summary: '',
      body: '',
    }
    store[0] = link(waiting)
    let refetched = 0
    server.use(
      http.post('/api/links/:space/:id/refetch', () => {
        refetched++
        const { body: _b, ...rest } = store[0] as LinkWithBody
        return HttpResponse.json({ ...rest, status: 'fetching' })
      }),
    )
    renderApp('/links')
    await waitFor(() => expect(screen.getByTestId('link-waiting')).toBeInTheDocument())
    expect(screen.getByTestId('link-waiting')).toHaveTextContent(
      'https://attacker.test/collect?q=plans',
    )
    expect(refetched).toBe(0)
    cleanup()
    renderApp('/links/ada/01JC0000000000000000000001')
    await waitFor(() => expect(screen.getByTestId('link-address')).toBeInTheDocument())
    expect(screen.getByTestId('link-address')).toHaveTextContent(
      'https://attacker.test/collect?q=plans',
    )
    expect(refetched).toBe(0)
    await user.click(screen.getByRole('button', { name: 'Get the page' }))
    await waitFor(() => expect(refetched).toBe(1))
    await waitFor(() => expect(screen.getByTestId('link-fetching')).toBeInTheDocument())
  })

  it('edits tags', async () => {
    const user = userEvent.setup()
    renderApp('/links/ada/01JC0000000000000000000001')
    await waitFor(() => expect(screen.getByTestId('link-edit-tags')).toBeInTheDocument())
    await user.click(screen.getByTestId('link-edit-tags'))
    await user.clear(screen.getByTestId('link-tags-input'))
    await user.type(screen.getByTestId('link-tags-input'), 'policy, mirror life{Enter}')
    await waitFor(() => expect(store[0]?.tags).toEqual(['policy', 'mirror life']))
  })
})

describe('reading position', () => {
  const place = (furthest: number, anchor = 3) => ({
    anchor,
    percent: furthest,
    furthest,
    updated: '2026-11-13T10:00:00Z',
  })

  it('R7: shows how far you got on links you started, and Read at the end', async () => {
    ;(store[0] as LinkWithBody).reading = place(42.7)
    ;(store[1] as LinkWithBody).reading = place(97)
    renderApp('/links')
    await waitFor(() => expect(screen.getAllByTestId('link-row')).toHaveLength(2))
    expect(screen.getByText(/The Journal · 5 min read · 42% read · saved/)).toBeInTheDocument()
    expect(screen.getByText(/b\.test · 5 min read · Read · saved/)).toBeInTheDocument()
    const bars = screen.getAllByTestId('link-progress-bar')
    expect(bars).toHaveLength(1)
    expect(bars[0]).toHaveAttribute('aria-valuenow', '42')
  })

  it('R7: a link never opened looks as before', async () => {
    renderApp('/links')
    await waitFor(() => expect(screen.getAllByTestId('link-row')).toHaveLength(2))
    expect(screen.queryByTestId('link-progress-bar')).toBeNull()
    expect(screen.queryByText(/% read/)).toBeNull()
  })

  it('R5: says it picked up where you left off, and Start from the top saves the top', async () => {
    const user = userEvent.setup()
    ;(store[0] as LinkWithBody).reading = place(60, 5)
    renderApp('/links/ada/01JC0000000000000000000001')
    expect(await screen.findByTestId('link-resumed')).toHaveTextContent(
      'Picked up where you left off',
    )
    await user.click(screen.getByTestId('link-start-over'))
    expect(screen.queryByTestId('link-resumed')).toBeNull()
    await waitFor(() => expect(places.map((p) => p.id)).toEqual([store[0]?.id]))
  })

  it('R5 R6: a link opened for the first time starts at the top and saves the place when left', async () => {
    const sent = vi.spyOn(globalThis, 'fetch')
    renderApp('/links/ada/01JC0000000000000000000001')
    await screen.findByTestId('link-body')
    expect(screen.queryByTestId('link-resumed')).toBeNull()
    window.dispatchEvent(new Event('pagehide'))
    // jsdom lays nothing out, and MSW drops keepalive, so the call itself is checked.
    const puts = () =>
      sent.mock.calls.filter(
        ([url, init]) => String(url).endsWith('/reading') && init?.method === 'PUT',
      )
    await waitFor(() => expect(puts().map(([, init]) => init?.keepalive)).toEqual([true]))
    await waitFor(() => expect(places.map((p) => p.id)).toEqual([store[0]?.id]))
    sent.mockRestore()
  })

  it('R6: saves nothing while the page is being fetched', async () => {
    ;(store[0] as LinkWithBody).status = 'fetching'
    renderApp('/links/ada/01JC0000000000000000000001')
    await screen.findByTestId('link-fetching')
    window.dispatchEvent(new Event('pagehide'))
    await new Promise((r) => setTimeout(r, 50))
    expect(places).toEqual([])
  })

  it('R2: sharing mid-read keeps your place under the new address', async () => {
    const user = userEvent.setup()
    ;(store[0] as LinkWithBody).reading = place(60, 5)
    const { router } = renderApp('/links/ada/01JC0000000000000000000001')
    await screen.findByTestId('link-resumed')
    await user.click(screen.getByTestId('link-share'))
    await user.click(screen.getByTestId('link-share-team'))
    await waitFor(() => expect(store[0]?.space).toBe('team'))
    // The page is at its new address before it is left (the store moves first, then the page).
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/links\/team\//))
    await screen.findByTestId('link-resumed')
    window.dispatchEvent(new Event('pagehide'))
    await waitFor(() => expect(places.length).toBeGreaterThan(0))
    expect(places.every((p) => p.space === 'team')).toBe(true)
  })

  it('R8: a Done button waits at the end of the article', async () => {
    const user = userEvent.setup()
    renderApp('/links/ada/01JC0000000000000000000001')
    await user.click(await screen.findByTestId('link-end-done'))
    await waitFor(() => expect(store[0]?.archived).toBe(true))
  })
})

describe('highlights and notes (docs/PLAN-links-highlights.md)', () => {
  const mine: LinkHighlight = {
    id: 'H-mine',
    by: 'ada@example.test',
    at: '2026-11-15T10:00:00Z',
    quote: 'Why it matters',
    block: 0,
    note: 'Start here',
    name: 'Ada',
  }
  const theirs: LinkHighlight = {
    id: 'H-bob',
    by: 'bob@example.test',
    at: '2026-11-15T11:00:00Z',
    quote: 'the paper',
    block: 1,
    name: 'Bob Builder',
  }

  /** Selects `words` in the copy the way a member's drag would. */
  function select(words: string) {
    const body = screen.getByTestId('link-body')
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = (n as Text).data.indexOf(words)
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(n, at)
      range.setEnd(n, at + words.length)
      const sel = document.getSelection() as Selection
      sel.removeAllRanges()
      sel.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      return
    }
    throw new Error(`"${words}" isn't in the copy`)
  }

  it('R11: selecting words offers Highlight, and saves the passage with its context', async () => {
    const user = userEvent.setup()
    renderApp('/links/ada/01JC0000000000000000000001')
    await screen.findByTestId('link-body')
    expect(screen.queryByTestId('link-highlights')).toBeNull()
    select('matters')
    await user.click(await screen.findByTestId('link-highlight'))
    await waitFor(() =>
      expect(posted.at(-1)).toEqual({
        highlight: {
          quote: 'matters',
          prefix: 'Why it ',
          suffix: '\nSee the paper. Picture: fig',
          block: 0,
        },
      }),
    )
    const section = await screen.findByTestId('link-highlights')
    expect(section).toHaveTextContent('Highlights 1')
    expect(screen.getAllByTestId('link-highlight-item')[0]).toHaveTextContent('matters')
  })

  it('R11: Add note asks for the note first and saves both at once', async () => {
    const user = userEvent.setup()
    renderApp('/links/ada/01JC0000000000000000000001')
    await screen.findByTestId('link-body')
    select('Why it')
    await user.click(await screen.findByTestId('link-add-note'))
    await user.type(screen.getByTestId('link-note-input'), 'Key point')
    await user.click(screen.getByTestId('link-note-save'))
    await waitFor(() =>
      expect(posted.at(-1)).toMatchObject({ highlight: { quote: 'Why it', note: 'Key point' } }),
    )
    expect(await screen.findByText('Key point')).toBeInTheDocument()
  })

  it('R11 R1: lists everyone’s highlights, names teammates, and Show only mine hides theirs', async () => {
    store[0] = {
      ...(store[0] as LinkWithBody),
      space: 'team',
      highlights: [{ ...theirs }, { ...mine }],
      highlightCount: 2,
    }
    const user = userEvent.setup()
    renderApp('/links/team/01JC0000000000000000000001')
    const items = await screen.findAllByTestId('link-highlight-item')
    // In page order, not the order they were made.
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('Why it matters'),
      expect.stringContaining('Bob Builder'),
    ])
    expect(items[0]).toHaveTextContent('Start here')
    expect(items[0]).not.toHaveTextContent('Ada')
    await user.click(screen.getByTestId('link-only-mine'))
    expect(screen.getAllByTestId('link-highlight-item')).toHaveLength(1)
  })

  it('R3: edits the note on your own highlight and removes it; a teammate’s has neither', async () => {
    store[0] = {
      ...(store[0] as LinkWithBody),
      space: 'team',
      highlights: [{ ...mine }, { ...theirs }],
      highlightCount: 2,
    }
    const user = userEvent.setup()
    renderApp('/links/team/01JC0000000000000000000001')
    const [own, other] = await screen.findAllByTestId('link-highlight-item')
    await user.click(within(other as HTMLElement).getByRole('button'))
    const popover = await screen.findByTestId('link-highlight-popover')
    expect(popover).toHaveTextContent('Highlighted by Bob Builder')
    expect(within(popover).queryByTestId('link-remove-highlight')).toBeNull()
    await user.click(within(own as HTMLElement).getByRole('button'))
    await user.click(await screen.findByTestId('link-edit-note'))
    const input = screen.getByTestId('link-note-input')
    await user.clear(input)
    await user.type(input, 'Read twice')
    await user.click(screen.getByTestId('link-note-save'))
    await waitFor(() => expect(posted.at(-1)).toEqual({ note: 'Read twice', hid: 'H-mine' }))
    await user.click(
      within(screen.getAllByTestId('link-highlight-item')[0] as HTMLElement).getByRole('button'),
    )
    await user.click(await screen.findByTestId('link-remove-highlight'))
    await waitFor(() => expect(posted.at(-1)).toEqual({ removed: 'H-mine' }))
    await waitFor(() => expect(screen.getAllByTestId('link-highlight-item')).toHaveLength(1))
  })

  it('R4: a highlight whose words left the page still lists, marked', async () => {
    store[0] = {
      ...(store[0] as LinkWithBody),
      highlights: [{ ...mine, quote: 'words that are gone' }],
      highlightCount: 1,
    }
    renderApp('/links/ada/01JC0000000000000000000001')
    expect(await screen.findByTestId('link-highlight-item')).toHaveTextContent(
      'Not in the page any more',
    )
  })

  it('R10: Copy to a Doc makes the doc and opens it', async () => {
    store[0] = { ...(store[0] as LinkWithBody), highlights: [{ ...mine }], highlightCount: 1 }
    const user = userEvent.setup()
    renderApp('/links/ada/01JC0000000000000000000001')
    await user.click(await screen.findByTestId('link-copy-highlights'))
    await waitFor(() => expect(posted.at(-1)).toEqual({ copied: true }))
    expect(await screen.findByText('Copied to “Highlights: Mirror life”')).toBeInTheDocument()
  })

  it('R13: Share with team says your highlights go with it', async () => {
    store[0] = { ...(store[0] as LinkWithBody), highlights: [{ ...mine }], highlightCount: 1 }
    renderApp('/links/ada/01JC0000000000000000000001')
    await userEvent.click(await screen.findByTestId('link-share'))
    await waitFor(() =>
      expect(screen.getByTestId('link-share-team')).toHaveTextContent(
        'Share with team (with your 1 highlight)',
      ),
    )
  })

  it('R12: the list counts highlights, and the Highlights tab lists them with their links', async () => {
    store[0] = { ...(store[0] as LinkWithBody), highlights: [{ ...mine }], highlightCount: 1 }
    const user = userEvent.setup()
    renderApp('/links')
    expect(await screen.findByText(/1 highlight/)).toBeInTheDocument()
    await user.click(screen.getByTestId('links-view-highlights'))
    const row = await screen.findByTestId('highlight-row')
    expect(row).toHaveTextContent('Why it matters')
    expect(row).toHaveTextContent('Start here')
    expect(row).toHaveTextContent('Mirror life, explained')
    expect(within(row).getByRole('link')).toHaveAttribute(
      'href',
      '/links/ada/01JC0000000000000000000001?highlight=H-mine',
    )
  })
})

describe('the save page', () => {
  it('keeps what was shared through sign-in', async () => {
    const { router } = renderApp('/links/save?url=https%3A%2F%2Fx.test%2Fa&via=share', {
      status: 'signed-out',
    })
    await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'))
    expect((router.state.location.state as { from: string }).from).toBe(
      '/links/save?url=https%3A%2F%2Fx.test%2Fa&via=share',
    )
    expect(posted).toEqual([])
  })

  it('asks before saving what was shared, then saves it once', async () => {
    const user = userEvent.setup()
    renderApp('/links/save?title=Look&text=Look%20at%20https%3A%2F%2Fshared.test%2Fx&via=share')
    await waitFor(() => expect(screen.getByTestId('link-save-confirm')).toBeInTheDocument())
    expect(screen.getByText('https://shared.test/x')).toBeInTheDocument()
    expect(posted).toEqual([])
    await user.click(screen.getByTestId('link-save-confirm'))
    await waitFor(() => expect(screen.getByTestId('link-saved')).toHaveTextContent('Saved'))
    expect(posted).toEqual([
      { text: 'Look at https://shared.test/x', title: 'Look', source: 'share' },
    ])
  })

  it('saves at once when the Chrome extension says it opened the tab, and tells it', async () => {
    const messages: unknown[] = []
    // Stands in for the extension's bridge: it answers "may-save" for a tab it opened.
    const bridge = (e: MessageEvent) => {
      messages.push(e.data)
      const d = e.data as { source?: string; type?: string; id?: string }
      if (d?.source === 'hearth-page' && d.type === 'may-save') {
        // jsdom's postMessage leaves origin and source empty; a browser fills both in.
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { source: 'hearth-extension', type: 'may-save', id: d.id, ok: true },
            origin: window.location.origin,
            source: window,
          }),
        )
      }
    }
    window.addEventListener('message', bridge)
    try {
      renderApp('/links/save?url=https%3A%2F%2Fjournal.test%2Fmirror&via=extension')
      await waitFor(() =>
        expect(screen.getByTestId('link-saved')).toHaveTextContent('Already saved'),
      )
      await waitFor(() =>
        expect(messages).toContainEqual({
          source: 'hearth-page',
          type: 'link-saved',
          id: 'save',
          ok: true,
        }),
      )
    } finally {
      window.removeEventListener('message', bridge)
    }
  })

  it('R8: sends the page the extension took along with the save', async () => {
    const bridge = (e: MessageEvent) => {
      const d = e.data as { source?: string; type?: string; id?: string }
      if (d?.source === 'hearth-page' && d.type === 'may-save') {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              source: 'hearth-extension',
              type: 'may-save',
              id: d.id,
              ok: true,
              page: '<html><body><p>Signed in</p></body></html>',
            },
            origin: window.location.origin,
            source: window,
          }),
        )
      }
    }
    window.addEventListener('message', bridge)
    try {
      renderApp('/links/save?url=https%3A%2F%2Fpaper.test%2Flocked&title=Locked&via=extension')
      await waitFor(() => expect(screen.getByTestId('link-saved')).toBeInTheDocument())
      expect(posted).toEqual([
        {
          url: 'https://paper.test/locked',
          title: 'Locked',
          source: 'extension',
          page: { html: '<html><body><p>Signed in</p></body></html>' },
        },
      ])
    } finally {
      window.removeEventListener('message', bridge)
    }
  })

  it('asks first when "via=extension" comes from somewhere else', async () => {
    renderApp('/links/save?url=https%3A%2F%2Fevil.test%2Fx&via=extension')
    await waitFor(() => expect(screen.getByTestId('link-save-confirm')).toBeInTheDocument(), {
      timeout: 4000,
    })
    expect(posted).toEqual([])
  })
})

describe('keys (slice 5)', () => {
  it('j moves to a link, o opens the original page and a marks it done', async () => {
    const user = userEvent.setup()
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    renderApp('/links')
    await waitFor(() => expect(screen.getAllByTestId('link-row')).toHaveLength(2))
    await user.keyboard('j')
    expect(screen.getAllByTestId('link-title')[0]).toHaveFocus()
    const first = store.find((l) => l.title === 'Mirror life, explained')
    await user.keyboard('o')
    expect(open).toHaveBeenCalledWith(first?.url, '_blank', 'noopener')
    await user.keyboard('a')
    await waitFor(() => expect(screen.getAllByTestId('link-row')).toHaveLength(1))
    expect(first?.archived).toBe(true)
    await waitFor(() => expect(screen.getAllByTestId('link-title')[0]).toHaveFocus())
    open.mockRestore()
  })
})

describe('PDFs and papers (docs/PLAN-links-pdfs.md)', () => {
  const paper = {
    server: 'arxiv' as const,
    id: '2401.00001',
    version: 2,
    authors: ['Ada Lovelace', 'Alan Turing', 'Grace Hopper', 'Katherine Johnson'],
    published: '2024-01-15',
    doi: '10.1000/x',
    abstract: 'We show that stand-in papers can be read.',
  }

  it('R10 R11: a paper shows its kind, authors, abstract and Open PDF', async () => {
    store[0] = link({
      id: '01JC0000000000000000000001',
      title: 'A stand-in paper',
      site: 'arxiv.org',
      url: 'https://arxiv.org/abs/2401.00001',
      summary: paper.abstract,
      file: '01JF0000000000000000000001',
      paper,
    })
    renderApp('/links')
    await waitFor(() => expect(screen.getAllByTestId('link-row')).toHaveLength(2))
    expect(screen.getByText(/^arXiv · arxiv\.org/)).toBeInTheDocument()
    cleanup()
    renderApp('/links/ada/01JC0000000000000000000001')
    await waitFor(() => expect(screen.getByTestId('link-paper')).toBeInTheDocument())
    expect(screen.getByTestId('link-paper')).toHaveTextContent(
      'Ada Lovelace, Alan Turing, Grace Hopper and 1 more · 2024-01-15 · arXiv v2 · doi:10.1000/x',
    )
    expect(screen.getByTestId('link-abstract')).toHaveTextContent(paper.abstract)
    expect(screen.getByTestId('link-open-pdf')).toHaveAttribute(
      'href',
      '/files/ada/01JF0000000000000000000001',
    )
    expect(screen.queryByTestId('link-add-pdf')).toBeNull()
  })

  it('R10: a scanned PDF from the computer says it has no text, with no original to open', async () => {
    store[0] = link({
      id: '01JC0000000000000000000001',
      url: '',
      site: '',
      title: 'Scan',
      words: null,
      body: '',
      summary: '',
      file: '01JF0000000000000000000002',
    })
    renderApp('/links/ada/01JC0000000000000000000001')
    await waitFor(() => expect(screen.getByTestId('link-no-text')).toBeInTheDocument())
    expect(screen.queryByTestId('link-original')).toBeNull()
    expect(screen.getByText(/A PDF from your computer/)).toBeInTheDocument()
  })

  it('R6: Add the PDF on a paper without one uploads it to Files and puts it on the link', async () => {
    const user = userEvent.setup()
    const attached: unknown[] = []
    const uploaded: unknown[] = []
    server.use(
      http.post('/api/files/uploads', async ({ request }) => {
        uploaded.push(await request.json())
        return HttpResponse.json({ id: 'U1', chunkBytes: 8_000_000, chunks: 1 })
      }),
      http.put('/api/files/uploads/U1/chunks/0', () => new HttpResponse(null, { status: 204 })),
      http.post('/api/files/uploads/U1/complete', () =>
        HttpResponse.json({ id: '01JF0000000000000000000009', space: 'ada' }),
      ),
      http.post('/api/links/:space/:id/pdf', async ({ request }) => {
        attached.push(await request.json())
        const l = store[0] as LinkWithBody
        l.file = '01JF0000000000000000000009'
        return HttpResponse.json(l)
      }),
    )
    store[0] = link({
      id: '01JC0000000000000000000001',
      url: 'https://www.biorxiv.org/content/10.1101/2024.02.01.1v1',
      paper: { ...paper, server: 'biorxiv' },
    })
    renderApp('/links/ada/01JC0000000000000000000001')
    await waitFor(() => expect(screen.getByTestId('link-add-pdf')).toBeInTheDocument())
    const pdf = new File(['%PDF-1.4'], 'preprint.pdf', { type: 'application/pdf' })
    await user.upload(screen.getByTestId('link-pdf-input'), pdf)
    await waitFor(() => expect(screen.getByTestId('link-open-pdf')).toBeInTheDocument())
    expect(uploaded).toEqual([
      expect.objectContaining({ space: 'ada', folder: 'Links', name: 'preprint.pdf' }),
    ])
    expect(attached).toEqual([{ file: '01JF0000000000000000000009' }])
  })

  it('R6: Add a PDF on the list saves it as a link, and refuses what isn’t a PDF', async () => {
    const user = userEvent.setup({ applyAccept: false })
    const saved: unknown[] = []
    server.use(
      http.post('/api/files/uploads', () =>
        HttpResponse.json({ id: 'U2', chunkBytes: 8_000_000, chunks: 1 }),
      ),
      http.put('/api/files/uploads/U2/chunks/0', () => new HttpResponse(null, { status: 204 })),
      http.post('/api/files/uploads/U2/complete', () =>
        HttpResponse.json({ id: '01JF0000000000000000000010', space: 'ada' }),
      ),
      http.post('/api/links/pdf', async ({ request }) => {
        saved.push(await request.json())
        const made = link({ id: '01JC0000000000000000000020', url: '', title: 'Notes' })
        store.unshift(made)
        return HttpResponse.json({ ...made, existing: false }, { status: 201 })
      }),
    )
    renderApp('/links')
    await waitFor(() => expect(screen.getAllByTestId('link-row')).toHaveLength(2))
    await user.upload(
      screen.getByTestId('links-pdf-input'),
      new File(['x'], 'photo.png', { type: 'image/png' }),
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('photo.png isn’t a PDF')
    await user.upload(
      screen.getByTestId('links-pdf-input'),
      new File(['%PDF-1.4'], 'Notes.pdf', { type: 'application/pdf' }),
    )
    await waitFor(() => expect(screen.getAllByTestId('link-row')).toHaveLength(3))
    expect(saved).toEqual([{ space: 'ada', file: '01JF0000000000000000000010' }])
  })
})
