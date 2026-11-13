import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TOUCH_QUERY } from '../../hooks/useMediaQuery'
import { server } from '../../test/mockServer'
import { renderApp } from '../../test/renderApp'

const capture = vi.hoisted(() => ({ fail: null as Error | null }))
vi.mock('../meetings/audio/capture', async (original) => {
  const real = await original<typeof import('../meetings/audio/capture')>()
  return {
    ...real,
    captureAudio: vi.fn(async () => {
      if (capture.fail) throw capture.fail
      throw new Error('not in this test')
    }),
  }
})

const realMatchMedia = window.matchMedia

/** Makes this jsdom a phone: the touch query matches, every other query doesn't. */
function asPhone(): void {
  window.matchMedia = ((query: string) => ({
    ...realMatchMedia(query),
    matches: query === TOUCH_QUERY,
    media: query,
  })) as typeof window.matchMedia
}

const row = (title: string, template: string, path: string) => ({
  space: 'alice',
  path,
  title,
  date: '2026-11-11T22:12:00-05:00',
  duration_min: 3,
  attendees: [],
  companies: [],
  template,
  hasTranscript: true,
})

beforeEach(() => {
  server.use(
    http.get('/api/meetings', () =>
      HttpResponse.json([
        row('Pricing ideas', 'voice-note', 'meetings/2026/11/2026-11-11-10-12-pm-voice-note.md'),
        row('Acme sync', 'customer-call', 'meetings/2026/11/2026-11-11-acme-sync.md'),
      ]),
    ),
  )
})

afterEach(() => {
  window.matchMedia = realMatchMedia
  capture.fail = null
})

describe('Dictate on a phone', () => {
  it('opens on voice notes: the record button, only voice notes listed, no Mac download', async () => {
    asPhone()
    const { router } = renderApp('/dictate')
    expect(await screen.findByTestId('voice-record')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/dictate/voice')
    const list = await screen.findByTestId('voice-notes')
    expect(within(list).getByText('Pricing ideas')).toBeInTheDocument()
    expect(within(list).queryByText('Acme sync')).toBeNull()
    expect(screen.queryByTestId('mac-app-download')).toBeNull()
    const macLinks = screen.getAllByRole('link', { name: 'Get the Mac app' })
    expect(macLinks.map((a) => a.getAttribute('href'))).toContain('/settings#mac-app')
  })

  it('says how to allow the microphone when it was refused', async () => {
    asPhone()
    const { CaptureError } = await import('../meetings/audio/capture')
    capture.fail = new CaptureError('denied', 'no')
    renderApp('/dictate/voice')
    await userEvent.click(await screen.findByTestId('voice-record'))
    expect(await screen.findByTestId('voice-error')).toHaveTextContent(
      /needs your microphone. Allow it/,
    )
  })

  it('folds the word lists away until opened', async () => {
    asPhone()
    renderApp('/dictate/voice')
    const words = await screen.findByTestId('voice-words')
    expect(words).not.toHaveAttribute('open')
    await userEvent.click(within(words).getByText(/should spell right/))
    await waitFor(() =>
      expect(within(words).getByTestId('dictate-words-team')).toHaveTextContent('Acme'),
    )
  })
})

describe('Dictate on a computer', () => {
  it('keeps the Mac page, with a link to record a voice note here', async () => {
    const { router } = renderApp('/dictate')
    expect(await screen.findByTestId('dictate-voice-link')).toHaveAttribute(
      'href',
      '/dictate/voice',
    )
    expect(router.state.location.pathname).toBe('/dictate')
  })
})
