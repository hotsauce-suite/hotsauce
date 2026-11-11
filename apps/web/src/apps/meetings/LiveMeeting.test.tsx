import { EditorView } from '@codemirror/view'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { meetingsApi } from '../../api/meetings'
import type { MeetingSession } from '../../api/types'
import { mockApi } from '../../test/mockServer'
import { renderApp } from '../../test/renderApp'
import { BYTES_PER_SECOND } from './audio/pcm'
import { AudioRing } from './audio/ring-buffer'
import { beginLive, currentLive, notesDraftKey } from './live/controller'

// jsdom has no AudioWorklet; the recorder is stubbed where a capture is attached.
vi.mock('./audio/recorder', () => ({
  startRecorder: vi.fn(async () => ({ setPaused: vi.fn(), stop: vi.fn(async () => {}) })),
}))

const second = () => new Uint8Array(BYTES_PER_SECOND)

async function startLive(title = 'Acme sync'): Promise<MeetingSession> {
  const session = await meetingsApi.createSession({ title })
  beginLive(session, { ring: new AudioRing({ factory: null }) })
  return session
}

/** Types into the notepad the way CodeMirror would on a keystroke. */
function typeNotes(text: string) {
  const content = within(screen.getByTestId('live-notepad')).getByTestId('editor-content')
  const view = EditorView.findFromDOM(content)
  if (!view) throw new Error('no notepad editor')
  view.dispatch({ changes: { from: view.state.doc.length, insert: text } })
}

afterEach(async () => {
  await currentLive()?.dispose()
})

describe('Live meeting page', () => {
  it('streams the transcript by track: the latest line collapsed, every line expanded', async () => {
    const session = await startLive()
    renderApp(`/meetings/live/${session.id}`)
    expect(await screen.findByTestId('live-notepad')).toBeInTheDocument()
    expect(screen.getByTestId('recording-indicator')).toHaveAttribute('data-state', 'recording')
    await waitFor(() => expect(currentLive()?.socket.status).toBe('live'))

    const socket = currentLive()?.socket
    socket?.sendAudio('me', second())
    socket?.sendAudio('them', second())
    // Collapsed: one line, the latest thing said.
    const strip = screen.getByTestId('live-transcript')
    await waitFor(() =>
      expect(within(strip).getByTestId('transcript-segment')).toHaveAttribute('data-track', 'them'),
    )
    expect(strip).toHaveAttribute('data-expanded', 'false')

    socket?.sendAudio('me', second())
    await userEvent.click(within(strip).getByRole('button', { name: /Transcript/ }))
    const panel = screen.getByTestId('live-transcript')
    expect(panel).toHaveAttribute('data-expanded', 'true')
    await waitFor(() => expect(within(panel).getAllByTestId('transcript-segment')).toHaveLength(3))
    const segments = within(panel).getAllByTestId('transcript-segment')
    expect(segments.map((s) => s.dataset.track)).toEqual(['me', 'them', 'me'])
    expect(segments.map((s) => s.dataset.final)).toEqual(['true', 'true', 'true'])
    expect(segments[0]).toHaveTextContent('Me')
    expect(segments[0]).toHaveTextContent('me segment 1')
    expect(segments[1]).toHaveTextContent('Them')
    expect(segments[2]).toHaveTextContent('me segment 2')
  })

  it('sends the notes once typing pauses, and keeps a draft on this device', async () => {
    const session = await startLive()
    renderApp(`/meetings/live/${session.id}`)
    await screen.findByTestId('live-notepad')
    await waitFor(() => expect(currentLive()?.socket.status).toBe('live'))

    typeNotes('SSO before rollout')
    typeNotes('\npricing ok if annual')
    const fake = mockApi().meetings.sessions.get(session.id)
    // Not per keystroke: nothing has gone out yet.
    expect(fake?.rawNotes).toBe('')
    await waitFor(() => expect(fake?.rawNotes).toBe('SSO before rollout\npricing ok if annual'), {
      timeout: 2000,
    })
    expect(localStorage.getItem(notesDraftKey(session.id))).toBe(
      'SSO before rollout\npricing ok if annual',
    )
  })

  it('pauses and resumes, and Stop saves the notes and opens the note', async () => {
    const session = await startLive('Pilot sync')
    const { router } = renderApp(`/meetings/live/${session.id}`)
    await screen.findByTestId('live-notepad')
    await waitFor(() => expect(currentLive()?.socket.status).toBe('live'))
    const fake = mockApi().meetings.sessions.get(session.id)

    await userEvent.click(screen.getByTestId('pause'))
    await waitFor(() => expect(fake?.state).toBe('paused'))
    expect(screen.getByTestId('recording-indicator')).toHaveAttribute('data-state', 'paused')
    await userEvent.click(screen.getByTestId('resume'))
    await waitFor(() => expect(fake?.state).toBe('recording'))

    // Typed just before Stop: no debounce wait, Stop sends it first.
    typeNotes('rerun the third assay')
    await userEvent.click(screen.getByTestId('stop'))
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/meetings\/morgan\//))
    expect(fake?.state).toBe('saved')
    const raw = mockApi().repo.space('morgan').files.get(`.hearth/meetings/raw/${session.id}.md`)
    expect(raw).toBe('rerun the third assay')
    expect(localStorage.getItem(notesDraftKey(session.id))).toBeNull()
    expect(currentLive()).toBeNull()
  })

  it('Stop keeps the audio when the member ticks Keep audio', async () => {
    const session = await startLive('Keep it')
    const stop = vi.spyOn(meetingsApi, 'stop')
    renderApp(`/meetings/live/${session.id}`)
    const keep = await screen.findByTestId('keep-audio')
    expect(keep).not.toBeChecked()

    await userEvent.click(keep)
    // The server holds the choice too, so Save it now or an idle save keeps it as well.
    await waitFor(() => expect(mockApi().meetings.sessions.get(session.id)?.keepAudio).toBe(true))
    await userEvent.click(screen.getByTestId('stop'))

    await waitFor(() =>
      expect(stop).toHaveBeenCalledWith(session.id, expect.objectContaining({ keepAudio: true })),
    )
    stop.mockRestore()
  })

  it('shows Keep audio as the member left it when the page is opened again', async () => {
    const session = await startLive('Chosen before')
    await meetingsApi.setKeepAudio(session.id, true)
    await currentLive()?.dispose()
    renderApp(`/meetings/live/${session.id}`)
    expect(await screen.findByTestId('keep-audio')).toBeChecked()
  })

  it('says so when the Meet tab stops sharing, and keeps recording the mic', async () => {
    const session = await startLive()
    renderApp(`/meetings/live/${session.id}`)
    await screen.findByTestId('live-notepad')
    let ended: ((track: 'me' | 'them') => void) | null = null
    const stop = vi.fn()
    await currentLive()?.attachCapture({
      mode: 'meet-tab',
      streams: { me: {} as MediaStream, them: {} as MediaStream },
      onEnded: (listener) => {
        ended = listener
        return () => {}
      },
      stop,
    })
    expect(screen.queryByText(/isn’t capturing audio/)).toBeNull()

    act(() => ended?.('them'))
    expect(await screen.findByText(/The Meet tab stopped sharing/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Share the tab again' })).toBeInTheDocument()
    expect(screen.getByTestId('recording-indicator')).toHaveAttribute('data-state', 'recording')
    expect(stop).not.toHaveBeenCalled()
  })

  it('says when the meeting was stopped on another device, and keeps the typed notes to copy', async () => {
    const session = await startLive()
    renderApp(`/meetings/live/${session.id}`)
    await screen.findByTestId('live-notepad')
    await waitFor(() => expect(currentLive()?.socket.status).toBe('live'))
    typeNotes('one more thing')
    await meetingsApi.stop(session.id) // the other device
    expect(await screen.findByText(/stopped elsewhere/)).toBeInTheDocument()
    expect(screen.getByLabelText('Notes typed on this page')).toHaveValue('one more thing')
    expect(screen.queryByTestId('recording-indicator')).toBeNull()
    expect(currentLive()).toBeNull()
  })

  it('a Stop that fails says why and offers a retry; it never says another device stopped it', async () => {
    const session = await startLive('Push check')
    const { router } = renderApp(`/meetings/live/${session.id}`)
    await screen.findByTestId('live-notepad')
    await waitFor(() => expect(currentLive()?.socket.status).toBe('live'))
    const api = mockApi()

    api.meetings.failStop = true
    typeNotes('the last words')
    await userEvent.click(screen.getByTestId('stop'))
    expect(
      await screen.findByText('Could not push the meeting to the Git host'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/another device/)).toBeNull()
    expect(api.meetings.sessions.get(session.id)?.state).toBe('stopped')

    api.meetings.failStop = false
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/meetings\/morgan\//))
    expect(api.meetings.sessions.get(session.id)?.state).toBe('saved')
    expect(api.repo.space('morgan').files.get(`.hearth/meetings/raw/${session.id}.md`)).toBe(
      'the last words',
    )
    expect(localStorage.getItem(notesDraftKey(session.id))).toBeNull()
  })

  it('a meeting found stopped but not saved offers Save it now, which saves and opens the note', async () => {
    const session = await meetingsApi.createSession({ title: 'Half saved' })
    const api = mockApi()
    api.meetings.failStop = true
    await expect(meetingsApi.stop(session.id)).rejects.toThrow()
    api.meetings.failStop = false
    localStorage.setItem(notesDraftKey(session.id), 'typed on this device')

    const { router } = renderApp(`/meetings/live/${session.id}`)
    await userEvent.click(await screen.findByRole('button', { name: 'Save it now' }))
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/meetings\/morgan\//))
    expect(api.meetings.sessions.get(session.id)?.state).toBe('saved')
    // This device's draft went with the stop.
    expect(api.repo.space('morgan').files.get(`.hearth/meetings/raw/${session.id}.md`)).toBe(
      'typed on this device',
    )
    expect(localStorage.getItem(notesDraftKey(session.id))).toBeNull()
    expect(currentLive()).toBeNull()
  })

  it('after a reload, reattaches to the session and offers to resume capture', async () => {
    const session = await meetingsApi.createSession({ title: 'Reloaded' })
    await meetingsApi.putNotes(session.id, 'typed before the reload')
    renderApp(`/meetings/live/${session.id}`)
    expect(await screen.findByText(/This page isn’t capturing audio/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mic only' })).toBeInTheDocument()
    expect(screen.getByTestId('live-notepad')).toHaveTextContent('typed before the reload')
    expect(currentLive()?.session.id).toBe(session.id)
  })

  it('says a meeting someone else started is theirs, not that the connection failed', async () => {
    const theirs = mockApi().meetings.create(
      { email: 'priya@example.test', name: 'Priya Natarajan', handle: 'priya' },
      { title: 'Priya’s private call' },
    )
    renderApp(`/meetings/live/${theirs.id}`)
    expect(
      await screen.findByRole('heading', { name: /belongs to another member/ }),
    ).toBeInTheDocument()
    expect(screen.queryByText(/connection/)).toBeNull()
    expect(screen.queryByText('Priya’s private call')).toBeNull()
    expect(currentLive()).toBeNull()
  })

  it('says so when the meeting has already ended', async () => {
    const session = await meetingsApi.createSession({ title: 'Done' })
    await meetingsApi.stop(session.id)
    renderApp(`/meetings/live/${session.id}`)
    expect(await screen.findByText(/This meeting has ended/)).toBeInTheDocument()
    expect(currentLive()).toBeNull()
  })
})
