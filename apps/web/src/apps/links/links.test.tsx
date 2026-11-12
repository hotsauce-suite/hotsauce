import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LinkView, LinkWithBody } from '../../api/links'
import { server } from '../../test/mockServer'
import { renderApp } from '../../test/renderApp'

afterEach(cleanup)

let store: LinkWithBody[]
let posted: Array<Record<string, unknown>>

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

  it('asks first when "via=extension" comes from somewhere else', async () => {
    renderApp('/links/save?url=https%3A%2F%2Fevil.test%2Fx&via=extension')
    await waitFor(() => expect(screen.getByTestId('link-save-confirm')).toBeInTheDocument(), {
      timeout: 4000,
    })
    expect(posted).toEqual([])
  })
})
