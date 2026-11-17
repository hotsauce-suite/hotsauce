import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockApi, server } from '../../test/mockServer'
import { renderApp } from '../../test/renderApp'
import { currentLive } from './live/controller'

// No devices in jsdom: the capture module is stubbed, and so is the worklet recorder.
const capture = vi.hoisted(() => ({
  arrived: true,
  /** When set, the audio check waits for it, so a test can see the check still waiting. */
  hold: null as Promise<void> | null,
  stop: vi.fn(),
  captureAudio: vi.fn(),
}))

vi.mock('./audio/capture', async (importOriginal) => {
  const real = await importOriginal<typeof import('./audio/capture')>()
  return {
    ...real,
    supportsTabCapture: () => true,
    captureAudio: capture.captureAudio,
    audioArrived: async () => {
      await capture.hold
      return new Promise<boolean>((resolve) => setTimeout(() => resolve(capture.arrived), 20))
    },
  }
})

// The Chrome extension: absent unless a test installs it.
const extension = vi.hoisted(() => ({ version: null as string | null }))
vi.mock('./audio/extension', () => ({
  extensionVersion: async () => extension.version,
}))

vi.mock('./audio/recorder', () => ({
  startRecorder: vi.fn(async () => ({ setPaused: vi.fn(), stop: vi.fn(async () => {}) })),
}))

beforeEach(() => {
  extension.version = null
  capture.arrived = true
  capture.hold = null
  capture.stop.mockReset()
  capture.captureAudio.mockReset()
  capture.captureAudio.mockImplementation(async (mode: string) => ({
    mode,
    streams: mode === 'mic-only' ? { me: {} } : { me: {}, them: {} },
    onEnded: () => () => {},
    stop: capture.stop,
  }))
})

afterEach(async () => {
  await currentLive()?.dispose()
})

const checkState = () => screen.getByTestId('audio-check').dataset.state

describe('Start screen', () => {
  it('mic only: permission, the audio check, then Start creates the session and opens it live', async () => {
    const { router } = renderApp('/meetings/start?event=evt-acme-sync')
    await waitFor(() => expect(screen.getByTestId('start-title')).toHaveValue('Acme sync'))
    expect(screen.getByTestId('start-recording')).toBeDisabled()
    await userEvent.selectOptions(screen.getByTestId('start-template'), 'customer-call')

    // Held until it's been seen waiting: a 20 ms check can finish before a slow runner looks.
    let release = () => {}
    capture.hold = new Promise((r) => {
      release = r
    })
    await userEvent.click(screen.getByTestId('capture-mic-only'))
    expect(capture.captureAudio).toHaveBeenCalledWith('mic-only', 'abc-defg-hij')
    expect(checkState()).toBe('waiting')
    release()
    await waitFor(() => expect(checkState()).toBe('ok'))
    expect(screen.getByText('Sound is arriving')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('start-recording'))
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/meetings\/live\//))
    const id = router.state.location.pathname.split('/').pop() ?? ''
    const session = mockApi().meetings.sessions.get(id)
    expect(session).toMatchObject({
      title: 'Acme sync',
      template: 'customer-call',
      calendarEventId: 'evt-acme-sync',
      // The event's Meet call, so resuming capture later finds that tab.
      meetCode: 'abc-defg-hij',
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
    // The capture went to the live meeting; leaving the Start page didn't stop it.
    expect(capture.stop).not.toHaveBeenCalled()
    expect(currentLive()?.session.id).toBe(id)
  })

  it('a silent Meet tab fails the check: Check again, or Start anyway', async () => {
    capture.arrived = false
    renderApp('/meetings/start')
    await userEvent.click(await screen.findByTestId('capture-meet-tab'))
    expect(capture.captureAudio).toHaveBeenCalledWith('meet-tab', null)
    await waitFor(() => expect(checkState()).toBe('failed'))
    expect(screen.getByText(/No sound from the Meet tab yet/)).toBeInTheDocument()
    expect(screen.getByTestId('start-recording')).toHaveTextContent('Start anyway')
    expect(screen.getByTestId('start-recording')).toBeEnabled()

    capture.arrived = true
    await userEvent.click(screen.getByText('Check again'))
    expect(checkState()).toBe('waiting')
    await waitFor(() => expect(checkState()).toBe('ok'))
    expect(screen.getByTestId('start-recording')).toHaveTextContent('Start recording')
  })

  it('explains a refused share and releases nothing it never got', async () => {
    const { CaptureError } = await import('./audio/capture')
    capture.captureAudio.mockRejectedValueOnce(
      new CaptureError('no-tab-audio', 'That share has no sound. Tick “Share tab audio”.'),
    )
    renderApp('/meetings/start')
    await userEvent.click(await screen.findByTestId('capture-meet-tab'))
    await waitFor(() => expect(checkState()).toBe('failed'))
    expect(screen.getByText('That share has no sound. Tick “Share tab audio”.')).toBeInTheDocument()
    expect(screen.getByTestId('start-recording')).toBeDisabled()
  })

  it('releases the microphone when the page is left without starting', async () => {
    const { router } = renderApp('/meetings/start')
    await userEvent.click(await screen.findByTestId('capture-mic-only'))
    await waitFor(() => expect(checkState()).toBe('ok'))
    await router.navigate('/meetings')
    await waitFor(() => expect(capture.stop).toHaveBeenCalled())
  })

  it('releases a microphone allowed only after the page was left', async () => {
    let allow: () => void = () => {}
    capture.captureAudio.mockImplementationOnce(
      (mode: string) =>
        new Promise((resolve) => {
          allow = () =>
            resolve({ mode, streams: { me: {} }, onEnded: () => () => {}, stop: capture.stop })
        }),
    )
    const { router } = renderApp('/meetings/start')
    await userEvent.click(await screen.findByTestId('capture-mic-only'))
    await router.navigate('/meetings')
    await screen.findByTestId('meetings-home')
    allow()
    await waitFor(() => expect(capture.stop).toHaveBeenCalled())
  })

  it('releases the capture of a choice replaced while the browser was asking', async () => {
    let allowTab: () => void = () => {}
    const tabStop = vi.fn()
    capture.captureAudio.mockImplementationOnce(
      (mode: string) =>
        new Promise((resolve) => {
          allowTab = () =>
            resolve({ mode, streams: { me: {}, them: {} }, onEnded: () => () => {}, stop: tabStop })
        }),
    )
    renderApp('/meetings/start')
    await userEvent.click(await screen.findByTestId('capture-meet-tab'))
    await userEvent.click(screen.getByTestId('capture-mic-only'))
    await waitFor(() => expect(checkState()).toBe('ok'))
    allowTab()
    await waitFor(() => expect(tabStop).toHaveBeenCalled())
    // The mic-only choice stands.
    expect(screen.getByTestId('capture-mic-only')).toHaveAttribute('aria-pressed', 'true')
    expect(capture.stop).not.toHaveBeenCalled()
  })

  it('from the extension’s Take notes: matches the calendar event by its Meet link', async () => {
    extension.version = '0.1.0'
    const asked: string[] = []
    const onRequest = ({ request }: { request: Request }) => {
      const url = new URL(request.url)
      if (url.pathname.startsWith('/api/calendar/')) asked.push(url.pathname + url.search)
    }
    server.events.on('request:start', onRequest)
    try {
      renderApp('/meetings/start?via=extension&meet=abc-defg-hij')
      await waitFor(() => expect(screen.getByTestId('start-title')).toHaveValue('Acme sync'))
    } finally {
      server.events.removeListener('request:start', onRequest)
    }
    // The server matches the call; the page doesn't fetch the calendar to search it.
    expect(asked).toEqual(['/api/calendar/match?meet=abc-defg-hij'])
    expect(screen.getByTestId('capture-meet-tab')).toHaveTextContent('No share dialog')
    expect(screen.queryByText('Get the Chrome extension')).not.toBeInTheDocument()
    // The extension is asked for this call's tab, not whichever Meet tab was clicked last.
    await userEvent.click(screen.getByTestId('capture-meet-tab'))
    expect(capture.captureAudio).toHaveBeenCalledWith('meet-tab', 'abc-defg-hij')
  })

  it('?meet=: pre-fills from the server’s match and starts the meeting for that event', async () => {
    server.use(
      http.get('/api/calendar/match', ({ request }) =>
        new URL(request.url).searchParams.get('meet') === 'xyz-wxyz-abc'
          ? HttpResponse.json({
              event: {
                id: 'evt-weekly-planning',
                title: 'Weekly planning',
                start: new Date(Date.now() - 5 * 60_000).toISOString(),
                end: new Date(Date.now() + 40 * 60_000).toISOString(),
                attendees: [
                  { email: 'ada@example.test', name: 'Ada Lovelace' },
                  { email: 'priya@example.test', name: 'Priya Natarajan' },
                ],
                meetLink: 'https://meet.google.com/xyz-wxyz-abc',
              },
              by: 'meet',
            })
          : HttpResponse.json({ event: null, by: null }),
      ),
    )
    const { router } = renderApp('/meetings/start?via=extension&meet=xyz-wxyz-abc')
    await waitFor(() => expect(screen.getByTestId('start-title')).toHaveValue('Weekly planning'))
    expect(screen.getByText(/with Priya Natarajan$/)).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('capture-mic-only'))
    expect(capture.captureAudio).toHaveBeenCalledWith('mic-only', 'xyz-wxyz-abc')
    await waitFor(() => expect(checkState()).toBe('ok'))
    await userEvent.click(screen.getByTestId('start-recording'))
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/meetings\/live\//))
    const id = router.state.location.pathname.split('/').pop() ?? ''
    expect(mockApi().meetings.sessions.get(id)).toMatchObject({
      title: 'Weekly planning',
      calendarEventId: 'evt-weekly-planning',
      meetCode: 'xyz-wxyz-abc',
    })
  })

  it('?meet= with no matching event: a blank title, still for that call', async () => {
    const { router } = renderApp('/meetings/start?via=extension&meet=nop-nopq-nop')
    await userEvent.click(await screen.findByTestId('capture-mic-only'))
    await waitFor(() => expect(checkState()).toBe('ok'))
    expect(screen.getByTestId('start-title')).toHaveValue('')
    await userEvent.click(screen.getByTestId('start-recording'))
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/meetings\/live\//))
    const id = router.state.location.pathname.split('/').pop() ?? ''
    const session = mockApi().meetings.sessions.get(id)
    expect(session?.meetCode).toBe('nop-nopq-nop')
    expect(session?.calendarEventId).toBeUndefined()
  })

  it('outside the Mac app there is no “Any app on this Mac” choice', async () => {
    renderApp('/meetings/start')
    await screen.findByTestId('capture-mic-only')
    expect(screen.queryByTestId('capture-mac')).toBeNull()
  })

  it('in the Mac app: “Any app on this Mac” checks both tracks from the app’s frames', async () => {
    const w = window as { hearthMac?: unknown; webkit?: unknown }
    w.hearthMac = { meetingAudio: 1 }
    w.webkit = { messageHandlers: { hearthMeetingAudio: { postMessage: async () => null } } }
    const frames = new Set<(track: 'me' | 'them', pcm: Uint8Array) => void>()
    capture.captureAudio.mockImplementation(async (mode: string) => ({
      mode,
      streams: {},
      frames: {
        tracks: ['me', 'them'],
        onFrame: (l: (track: 'me' | 'them', pcm: Uint8Array) => void) => {
          frames.add(l)
          return () => frames.delete(l)
        },
      },
      onEnded: () => () => {},
      stop: capture.stop,
    }))
    try {
      renderApp('/meetings/start')
      await userEvent.click(await screen.findByTestId('capture-mac'))
      expect(capture.captureAudio).toHaveBeenCalledWith('mac', null)
      expect(checkState()).toBe('waiting')
      const loud = new Uint8Array([0x00, 0x10])
      for (const l of [...frames]) {
        l('me', loud)
        l('them', loud)
      }
      await waitFor(() => expect(checkState()).toBe('ok'))
    } finally {
      // The meeting this started stops while the app's bridge is still there to tell.
      await currentLive()?.dispose()
      delete w.hearthMac
      delete w.webkit
    }
  })

  it('from the Mac app’s call notice: titled for the app, listening and recording at once', async () => {
    const w = window as { hearthMac?: unknown; webkit?: unknown }
    w.hearthMac = { meetingAudio: 1 }
    w.webkit = { messageHandlers: { hearthMeetingAudio: { postMessage: async () => null } } }
    try {
      const { router } = renderApp('/meetings/start?via=mac-call&app=Zoom')
      await waitFor(() => expect(capture.captureAudio).toHaveBeenCalledWith('mac', null))
      expect(capture.captureAudio).toHaveBeenCalledTimes(1)
      await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/meetings\/live\//))
      const id = router.state.location.pathname.split('/').pop() ?? ''
      expect(mockApi().meetings.sessions.get(id)).toMatchObject({ title: 'Zoom call' })
    } finally {
      // The meeting this started stops while the app's bridge is still there to tell.
      await currentLive()?.dispose()
      delete w.hearthMac
      delete w.webkit
    }
  })

  it('from the Mac app’s calendar reminder: starts recording for that event without a click', async () => {
    const w = window as { hearthMac?: unknown; webkit?: unknown }
    w.hearthMac = { meetingAudio: 1 }
    w.webkit = { messageHandlers: { hearthMeetingAudio: { postMessage: async () => null } } }
    // Silent call audio (nobody has joined yet) doesn't hold the start up.
    capture.arrived = false
    try {
      const { router } = renderApp('/meetings/start?event=evt-acme-sync&via=mac-reminder')
      await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/meetings\/live\//))
      expect(capture.captureAudio).toHaveBeenCalledTimes(1)
      expect(capture.captureAudio.mock.calls[0]?.[0]).toBe('mac')
      const id = router.state.location.pathname.split('/').pop() ?? ''
      expect(mockApi().meetings.sessions.get(id)).toMatchObject({
        title: 'Acme sync',
        calendarEventId: 'evt-acme-sync',
        meetCode: 'abc-defg-hij',
      })
    } finally {
      // The meeting this started stops while the app's bridge is still there to tell.
      await currentLive()?.dispose()
      delete w.hearthMac
      delete w.webkit
    }
  })

  it('from the call notice for a reminded meeting: named for the event, and it ends with the call', async () => {
    const w = window as { hearthMac?: unknown; webkit?: unknown }
    const postMessage = vi.fn(async (_message: unknown) => null)
    w.hearthMac = { meetingAudio: 2 }
    w.webkit = { messageHandlers: { hearthMeetingAudio: { postMessage } } }
    try {
      const { router } = renderApp('/meetings/start?event=evt-acme-sync&via=mac-call&app=Zoom')
      await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/meetings\/live\//))
      const id = router.state.location.pathname.split('/').pop() ?? ''
      expect(mockApi().meetings.sessions.get(id)).toMatchObject({
        title: 'Acme sync',
        calendarEventId: 'evt-acme-sync',
      })
      await waitFor(() =>
        expect(postMessage).toHaveBeenCalledWith({ type: 'follow-call', session: id }),
      )
    } finally {
      await currentLive()?.dispose()
      delete w.hearthMac
      delete w.webkit
    }
  })

  it('a reminder opened on a Start page that is already showing starts for the new event', async () => {
    const w = window as { hearthMac?: unknown; webkit?: unknown }
    w.hearthMac = { meetingAudio: 1 }
    w.webkit = { messageHandlers: { hearthMeetingAudio: { postMessage: async () => null } } }
    try {
      const { router } = renderApp('/meetings/start')
      await screen.findByTestId('start-title')
      await router.navigate('/meetings/start?event=evt-acme-sync&via=mac-reminder')
      await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/meetings\/live\//))
      const id = router.state.location.pathname.split('/').pop() ?? ''
      expect(mockApi().meetings.sessions.get(id)).toMatchObject({
        calendarEventId: 'evt-acme-sync',
      })
    } finally {
      // The meeting this started stops while the app's bridge is still there to tell.
      await currentLive()?.dispose()
      delete w.hearthMac
      delete w.webkit
    }
  })

  it('a member who picks another way during the reminder’s sound check presses Start themselves', async () => {
    const w = window as { hearthMac?: unknown; webkit?: unknown }
    w.hearthMac = { meetingAudio: 1 }
    w.webkit = { messageHandlers: { hearthMeetingAudio: { postMessage: async () => null } } }
    let release = () => {}
    capture.hold = new Promise((r) => {
      release = r
    })
    try {
      const { router } = renderApp('/meetings/start?event=evt-acme-sync&via=mac-reminder')
      await waitFor(() => expect(capture.captureAudio.mock.calls[0]?.[0]).toBe('mac'))
      await userEvent.click(screen.getByTestId('capture-mic-only'))
      release()
      await waitFor(() => expect(checkState()).toBe('ok'))
      await new Promise((r) => setTimeout(r, 50))
      expect(router.state.location.pathname).toBe('/meetings/start')
      expect(screen.getByTestId('start-recording')).toBeEnabled()
    } finally {
      // The meeting this started stops while the app's bridge is still there to tell.
      await currentLive()?.dispose()
      delete w.hearthMac
      delete w.webkit
    }
  })

  it('in the Mac app, a silent call says the app may not be allowed to hear other apps', async () => {
    const w = window as { hearthMac?: unknown; webkit?: unknown }
    const postMessage = vi.fn(async (_message: unknown) => null)
    w.hearthMac = { meetingAudio: 2 }
    w.webkit = { messageHandlers: { hearthMeetingAudio: { postMessage } } }
    const frames = new Set<(track: 'me' | 'them', pcm: Uint8Array) => void>()
    capture.captureAudio.mockImplementation(async (mode: string) => ({
      mode,
      streams: {},
      frames: {
        tracks: ['me', 'them'],
        onFrame: (l: (track: 'me' | 'them', pcm: Uint8Array) => void) => {
          frames.add(l)
          return () => frames.delete(l)
        },
      },
      onEnded: () => () => {},
      stop: capture.stop,
    }))
    try {
      renderApp('/meetings/start')
      await userEvent.click(await screen.findByTestId('capture-mac'))
      for (const l of [...frames]) l('me', new Uint8Array([0x00, 0x10]))
      await waitFor(() => expect(checkState()).toBe('failed'), { timeout: 5000 })
      expect(screen.getByText('The call, from apps on this Mac')).toBeInTheDocument()
      expect(screen.queryByText('The call, from the Meet tab')).toBeNull()
      expect(screen.getByTestId('audio-check')).toHaveTextContent(
        'isn’t allowed to hear other apps yet',
      )
      await userEvent.click(screen.getByTestId('open-audio-settings'))
      expect(postMessage).toHaveBeenCalledWith({ type: 'open-audio-settings' })
      // Someone on the call speaks later: the check turns green by itself, no Check again.
      for (const l of [...frames]) l('them', new Uint8Array([0x00, 0x10]))
      await waitFor(() => expect(checkState()).toBe('ok'))
    } finally {
      delete w.hearthMac
      delete w.webkit
    }
  })

  it('a calendar reminder opened outside the Mac app only fills the page in', async () => {
    renderApp('/meetings/start?event=evt-acme-sync&via=mac-reminder')
    await waitFor(() => expect(screen.getByTestId('start-title')).toHaveValue('Acme sync'))
    expect(capture.captureAudio).not.toHaveBeenCalled()
    expect(screen.getByTestId('start-recording')).toBeDisabled()
  })

  it('from the call notice in mic-only mode: the meeting still ends with the call', async () => {
    const w = window as { hearthMac?: unknown; webkit?: unknown }
    const postMessage = vi.fn(async (_message: unknown) => null)
    w.hearthMac = { meetingAudio: 2 }
    w.webkit = { messageHandlers: { hearthMeetingAudio: { postMessage } } }
    try {
      // The Mac check is held, so the notice's automatic start can't beat the switch to mic only.
      let release = () => {}
      capture.hold = new Promise((r) => {
        release = r
      })
      const { router } = renderApp('/meetings/start?via=mac-call&app=Zoom')
      await waitFor(() => expect(capture.captureAudio).toHaveBeenCalledWith('mac', null))
      await userEvent.click(screen.getByTestId('capture-mic-only'))
      release()
      await waitFor(() => expect(checkState()).toBe('ok'))
      await userEvent.click(screen.getByTestId('start-recording'))
      await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/meetings\/live\//))
      const id = router.state.location.pathname.split('/').pop() ?? ''
      expect(postMessage).toHaveBeenCalledWith({ type: 'follow-call', session: id })
      await waitFor(() => expect(currentLive()?.session.id).toBe(id))
      // Resume capture (a new mic) keeps following the call: the old one lets go, the new one follows.
      postMessage.mockClear()
      await currentLive()?.attachCapture({
        mode: 'mic-only',
        streams: { me: {} as MediaStream },
        onEnded: () => () => {},
        stop: vi.fn(),
      })
      expect(postMessage.mock.calls.map(([m]) => m)).toEqual([
        { type: 'stop', session: id },
        { type: 'follow-call', session: id },
      ])
      window.dispatchEvent(
        new CustomEvent('hearth-mac-audio', { detail: { session: id, type: 'call-ended' } }),
      )
      expect(await screen.findByTestId('call-ended')).toBeInTheDocument()
    } finally {
      delete w.hearthMac
      delete w.webkit
    }
  })

  it('without the extension, points to it from the Meet tab choice', async () => {
    renderApp('/meetings/start')
    expect(await screen.findByText('Get the Chrome extension')).toHaveAttribute(
      'href',
      '/meetings/extension',
    )
    expect(screen.getByTestId('capture-meet-tab')).toHaveTextContent('Share tab audio')
  })
})
