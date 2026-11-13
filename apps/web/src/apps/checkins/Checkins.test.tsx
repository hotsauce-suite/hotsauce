import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DICTATED_WORDS } from '../../mocks/checkinHandlers'
import { renderApp } from '../../test/renderApp'

// Check-ins in the web app (docs/PLAN-checkins.md R8, R9, R14) against the MSW mock.

afterEach(() => {
  vi.unstubAllGlobals()
})

async function openCheckin() {
  renderApp('/checkins')
  const list = await screen.findByTestId('checkins-list')
  await userEvent.click(await within(list).findByText('What will you get done this week?'))
  return screen.findByTestId('checkin-answer-box')
}

describe('Check-ins', () => {
  it('R14: lists check-ins, and an admin sees the second default to add', async () => {
    renderApp('/checkins')
    expect(await screen.findByText('What will you get done this week?')).toBeInTheDocument()
    expect(screen.getByText('Answer now')).toBeInTheDocument()
    const presets = screen.getAllByTestId('checkin-preset')
    expect(presets.map((p) => p.textContent)).toEqual(['What got done, and what’s stuck?'])
    await userEvent.click(presets[0] as HTMLElement)
    const dialog = await screen.findByTestId('checkin-dialog')
    expect(within(dialog).getByTestId('checkin-question')).toHaveValue(
      'What got done, and what’s stuck?',
    )
    expect(within(dialog).getByTestId('checkin-day-fri')).toHaveAttribute('aria-pressed', 'true')
    expect(within(dialog).getByTestId('checkin-time')).toHaveValue('15:00')
  })

  it('R5, R6: answers the round, then replies under the answer', async () => {
    await openCheckin()
    // The sample round: Grace has answered, with a reply; last week has a summary.
    expect(screen.getAllByTestId('checkin-round')).toHaveLength(2)
    expect(screen.getByTestId('checkin-summary')).toHaveTextContent('Nothing stuck this week')
    await userEvent.type(screen.getByTestId('checkin-answer'), 'Ship the report')
    await userEvent.click(screen.getByTestId('checkin-submit'))
    expect(await screen.findByTestId('checkin-edit-answer')).toBeInTheDocument()
    const mine = () =>
      screen
        .getAllByTestId('checkin-answer-card')
        .find((c) => within(c).queryByText('You')) as HTMLElement
    await waitFor(() => expect(mine()).toBeDefined())
    const card = mine()
    expect(within(card).getByTestId('checkin-answer-text')).toHaveTextContent('Ship the report')
    await userEvent.click(within(card).getByTestId('checkin-reply-open'))
    await userEvent.type(within(card).getByTestId('checkin-reply-input'), 'Nice')
    await userEvent.click(within(card).getByTestId('checkin-reply-send'))
    await waitFor(() =>
      expect(within(mine()).getByTestId('checkin-reply')).toHaveTextContent('Nice'),
    )
  })

  it('R9: Dictate puts the spoken words in the answer box', async () => {
    class FakeRecorder {
      state = 'inactive'
      mimeType = 'audio/webm'
      ondataavailable: ((e: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      static isTypeSupported = () => true
      start() {
        this.state = 'recording'
      }
      stop() {
        this.state = 'inactive'
        this.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) })
        this.onstop?.()
      }
    }
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
    })
    await openCheckin()
    const dictate = screen.getByTestId('checkin-dictate')
    await userEvent.click(dictate)
    await waitFor(() => expect(dictate).toHaveAttribute('data-phase', 'recording'))
    await userEvent.click(dictate)
    await waitFor(() => expect(screen.getByTestId('checkin-answer')).toHaveValue(DICTATED_WORDS))
  })

  it('R8: Today shows the check-in until it is answered', async () => {
    renderApp('/today')
    const card = await screen.findByTestId('today-checkins')
    const link = within(card).getByTestId('today-checkin')
    expect(link).toHaveTextContent('What will you get done this week?')
    await userEvent.click(link)
    await screen.findByTestId('checkin-answer-box')
  })
})
