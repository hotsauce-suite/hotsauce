import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { capturePage, clearPageShot } from '../feedback/pageShot'
import { server } from '../test/mockServer'
import { renderApp } from '../test/renderApp'

// docs/PLAN-feedback-screenshots.md S6, S7, S9.

const png = (name = 'shot.png') =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], name, {
    type: 'image/png',
  })

let sent: { payload: Record<string, unknown>; files: File[]; json: boolean } | null = null

beforeEach(() => {
  sent = null
  let n = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:preview-${++n}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  server.use(
    http.get('/api/feedback/status', () => HttpResponse.json({ enabled: true })),
    http.get('/api/feedback/mine', () => HttpResponse.json({ items: [] })),
    http.post('/api/feedback/clarify', () =>
      HttpResponse.json({ ready: true, title: 'Chart blank', summary: 'The chart is blank.' }),
    ),
    http.post('/api/feedback', async ({ request }) => {
      if ((request.headers.get('content-type') ?? '').startsWith('multipart/form-data')) {
        const form = await request.formData()
        sent = {
          payload: JSON.parse(String(form.get('payload'))),
          files: form.getAll('screenshot') as File[],
          json: false,
        }
      } else {
        sent = { payload: (await request.json()) as Record<string, unknown>, files: [], json: true }
      }
      return HttpResponse.json({ number: 1, url: 'u' }, { status: 201 })
    }),
  )
})

afterEach(() => clearPageShot())

function open(path = '/feedback?from=%2Fdocs') {
  renderApp(path)
}

async function write(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByTestId('feedback-text'), 'The chart on Today is blank')
}

describe('Send feedback screenshots', () => {
  it('offers the page picture, attaches it only when tapped, and sends it (S6)', async () => {
    const user = userEvent.setup()
    await capturePage(async () => png('page.png'), '/docs')
    open()
    const offer = await screen.findByTestId('feedback-page-shot')
    expect(within(offer).getByRole('img')).toHaveAttribute('src', 'blob:preview-1')
    expect(screen.queryByTestId('feedback-shot')).not.toBeInTheDocument()
    await user.click(
      within(offer).getByRole('button', { name: /add a picture of the page you were on/i }),
    )
    expect(await screen.findAllByTestId('feedback-shot')).toHaveLength(1)
    expect(screen.queryByTestId('feedback-page-shot')).not.toBeInTheDocument()
    await write(user)
    await user.click(screen.getByTestId('feedback-send'))
    await screen.findByTestId('feedback-sent')
    expect(sent?.json).toBe(false)
    expect(sent?.files).toHaveLength(1)
    expect(sent?.payload).toMatchObject({ kind: 'bug', text: 'The chart on Today is blank' })
  })

  it('sends plain JSON when the page picture is not tapped', async () => {
    const user = userEvent.setup()
    await capturePage(async () => png('page.png'), '/docs')
    open()
    await screen.findByTestId('feedback-page-shot')
    await write(user)
    await user.click(screen.getByTestId('feedback-send'))
    await screen.findByTestId('feedback-sent')
    expect(sent).toMatchObject({ json: true, files: [] })
  })

  it('offers no page picture when there is none', async () => {
    open()
    await screen.findByTestId('feedback-text')
    expect(screen.queryByTestId('feedback-page-shot')).not.toBeInTheDocument()
  })

  it('adds pictures by button, paste and drop, at most three, each removable (S7)', async () => {
    const user = userEvent.setup()
    open()
    const input = await screen.findByLabelText('Add screenshot')
    expect(input).toHaveAttribute('accept', 'image/*')
    await user.upload(input, png('one.png'))
    const form = screen.getByTestId('feedback-form')
    fireEvent.paste(form, { clipboardData: { files: [png('two.png')], getData: () => '' } })
    fireEvent.drop(form, { dataTransfer: { files: [png('three.png')], types: ['Files'] } })
    await waitFor(() => expect(screen.getAllByTestId('feedback-shot')).toHaveLength(3))
    // A fourth is refused, and the button is gone.
    fireEvent.paste(form, { clipboardData: { files: [png('four.png')], getData: () => '' } })
    expect(await screen.findByText(/up to 3 pictures/i)).toBeInTheDocument()
    expect(screen.getAllByTestId('feedback-shot')).toHaveLength(3)
    expect(screen.queryByLabelText('Add screenshot')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Remove screenshot 2' }))
    expect(screen.getAllByTestId('feedback-shot')).toHaveLength(2)
    expect(screen.getByLabelText('Add screenshot')).toBeInTheDocument()

    await write(user)
    await user.click(screen.getByTestId('feedback-send'))
    await screen.findByTestId('feedback-sent')
    expect(sent?.files.map((f) => f.size)).toEqual([8, 8])
  })

  it('counts the page picture in the three', async () => {
    const user = userEvent.setup()
    await capturePage(async () => png('page.png'), '/docs')
    open()
    const input = await screen.findByLabelText('Add screenshot')
    await user.upload(input, [png('a.png'), png('b.png'), png('c.png')])
    await waitFor(() => expect(screen.getAllByTestId('feedback-shot')).toHaveLength(3))
    expect(screen.queryByTestId('feedback-page-shot')).not.toBeInTheDocument()
  })

  it('ignores files that are not pictures', async () => {
    open()
    const form = await screen.findByTestId('feedback-form')
    const text = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    fireEvent.drop(form, { dataTransfer: { files: [text], types: ['Files'] } })
    expect(await screen.findByText(/only pictures/i)).toBeInTheDocument()
    expect(screen.queryByTestId('feedback-shot')).not.toBeInTheDocument()
  })

  it('warns that screenshots are sent as they are (S9)', async () => {
    open()
    expect(
      await screen.findByText(
        /screenshots are sent as they are, so check them for anything private/i,
      ),
    ).toBeInTheDocument()
  })
})
