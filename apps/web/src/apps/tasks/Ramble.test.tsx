import { addDays, localNow } from '@hearth/format'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memberTimeZone } from '../../api/tasks'
import { mockApi, server } from '../../test/mockServer'
import { renderApp } from '../../test/renderApp'
import { forgetTaskLists } from './useTaskList'
import { forgetTaskMeta } from './useTaskMeta'

/** A MediaRecorder that hands over one chunk of fake audio when stopped. */
class FakeRecorder {
  static last: FakeRecorder | null = null
  static isTypeSupported = (type: string) => type.startsWith('audio/webm')
  state: 'inactive' | 'recording' = 'inactive'
  mimeType: string
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  constructor(_stream: MediaStream, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? 'audio/webm'
    FakeRecorder.last = this
  }
  start() {
    this.state = 'recording'
  }
  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['fake audio'], { type: this.mimeType }) })
    this.onstop?.()
  }
}

const stopTrack = vi.fn()

beforeEach(() => {
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })),
    },
  })
})

afterEach(() => {
  server.events.removeAllListeners()
  vi.unstubAllGlobals()
  forgetTaskLists()
  forgetTaskMeta()
  stopTrack.mockClear()
})

const today = () => localNow(new Date(), memberTimeZone()).date

describe('Ramble', () => {
  it('records, shows the proposed tasks as editable lines, and adds the checked ones', async () => {
    let sent: { type: string | null; tz: string | null } | null = null
    server.events.on('request:start', ({ request }) => {
      if (request.url.includes('/api/tasks/ramble')) {
        sent = {
          type: request.headers.get('content-type'),
          tz: new URL(request.url).searchParams.get('tz'),
        }
      }
    })
    renderApp('/tasks')
    await screen.findAllByTestId('task-row')
    await userEvent.click(screen.getByTestId('quick-add-open'))
    await userEvent.click(screen.getByTestId('ramble-open'))

    const stop = await screen.findByTestId('ramble-stop')
    await waitFor(() => expect(stop).toBeEnabled())
    expect(screen.getByTestId('ramble-timer')).toHaveTextContent('0:00')
    await userEvent.click(stop)

    const review = await screen.findByTestId('ramble-review')
    expect(sent).toEqual({ type: 'audio/webm', tz: memberTimeZone() })
    expect(stopTrack).toHaveBeenCalled()
    expect(review).toHaveTextContent('3 tasks heard')
    const inputs = within(review).getAllByTestId('ramble-line-input') as HTMLInputElement[]
    expect(inputs.map((i) => i.value)).toEqual([
      'Call Sam about the pilot budget tomorrow 3pm',
      'Book flights to Boston next week p2',
      'Review the audit draft #Compliance',
    ])
    // Each line shows its chips, live.
    const lines = within(review).getAllByTestId('ramble-line')
    expect(
      within(lines[0] as HTMLElement)
        .getAllByTestId('quick-chip')
        .map((c) => c.textContent),
    ).toEqual(['Tomorrow 3:00 PM'])

    // Edit one, drop another.
    await userEvent.type(inputs[0] as HTMLInputElement, ' p1')
    expect(
      within(lines[0] as HTMLElement)
        .getAllByTestId('quick-chip')
        .map((c) => c.textContent),
    ).toEqual(['Tomorrow 3:00 PM', 'P1'])
    await userEvent.click(within(lines[1] as HTMLElement).getByRole('checkbox'))
    expect(screen.getByTestId('ramble-add')).toHaveTextContent('Add 2 tasks')
    await userEvent.click(screen.getByTestId('ramble-add'))

    await waitFor(() => expect(screen.queryByTestId('ramble')).not.toBeInTheDocument())
    const all = [...mockApi().tasks.tasks.values()]
    const call = all.find(
      (t) => t.title === 'Call Sam about the pilot budget' && t.source?.kind === 'voice',
    )
    expect(call).toMatchObject({ due: `${addDays(today(), 1)}T15:00`, priority: 1 })
    expect(all.find((t) => t.title === 'Review the audit draft')).toMatchObject({
      project: 'Compliance',
      source: { kind: 'voice' },
    })
    expect(all.some((t) => t.title.startsWith('Book flights to Boston'))).toBe(false)
  })

  it('sends tasks for a teammate or a team project to Team; the rest stay personal', async () => {
    mockApi().tasks.ramble = {
      transcript: 'Renew my passport. Priya sends the deck.',
      lines: ['Renew my passport tomorrow', 'Send the deck +priya', 'Book the venue #Launch'],
    }
    renderApp('/tasks')
    await screen.findAllByTestId('task-row')
    await userEvent.click(screen.getByTestId('quick-add-open'))
    await userEvent.click(screen.getByTestId('ramble-open'))
    const stop = await screen.findByTestId('ramble-stop')
    await waitFor(() => expect(stop).toBeEnabled())
    await userEvent.click(stop)
    await screen.findByTestId('ramble-review')
    expect(screen.getByTestId('ramble-team-note')).toHaveTextContent('teammates go to Team')
    await userEvent.click(screen.getByTestId('ramble-add'))
    await waitFor(() => expect(screen.queryByTestId('ramble')).not.toBeInTheDocument())
    const all = [...mockApi().tasks.tasks.values()]
    const passport = all.find((t) => t.title === 'Renew my passport')
    const deck = all.find((t) => t.title === 'Send the deck')
    expect(deck?.space).toBe('team')
    expect(passport?.space).not.toBe('team')
    // A line filed under a team project goes to that project in Team.
    expect(all.find((t) => t.title === 'Book the venue')).toMatchObject({
      space: 'team',
      project: 'Launch',
    })
  })

  it('says so when the microphone is refused', async () => {
    navigator.mediaDevices.getUserMedia = vi.fn(async () => {
      throw new DOMException('denied', 'NotAllowedError')
    })
    renderApp('/tasks')
    await screen.findAllByTestId('task-row')
    await userEvent.click(screen.getByTestId('quick-add-open'))
    await userEvent.click(screen.getByTestId('ramble-open'))
    expect(await screen.findByRole('alert')).toHaveTextContent('can’t use your microphone')
  })

  it('says so when the server can’t turn it into tasks', async () => {
    server.use(
      http.post('/api/tasks/ramble', () =>
        HttpResponse.json(
          { error: { code: 'too_large', message: 'That recording is too long' } },
          { status: 413 },
        ),
      ),
    )
    renderApp('/tasks')
    await screen.findAllByTestId('task-row')
    await userEvent.click(screen.getByTestId('quick-add-open'))
    await userEvent.click(screen.getByTestId('ramble-open'))
    const stop = await screen.findByTestId('ramble-stop')
    await waitFor(() => expect(stop).toBeEnabled())
    await userEvent.click(stop)
    expect(await screen.findByRole('alert')).toHaveTextContent('That recording is too long')
  })
})
