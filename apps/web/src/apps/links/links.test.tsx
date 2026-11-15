import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinkView, LinkWithBody } from '../../api/links'
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
    renderApp('/links/ada/01JC0000000000000000000001')
    await screen.findByTestId('link-resumed')
    await user.click(screen.getByTestId('link-share-team'))
    await waitFor(() => expect(store[0]?.space).toBe('team'))
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
