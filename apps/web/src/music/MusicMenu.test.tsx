import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_QUERY } from '../hooks/useMediaQuery'
import { renderApp } from '../test/renderApp'
import { MUSIC_KEY } from './player'

// The music controls in the shell (docs/PLAN-background-music.md, M2 and M6).

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

const saved = () => JSON.parse(localStorage.getItem(MUSIC_KEY) ?? 'null')

describe('background music controls', () => {
  it('M2: Music in the account menu opens the controls, which play, change track and volume, and pause', async () => {
    renderApp('/docs')
    const account = await screen.findByTestId('account-menu')
    // No music note on the rail any more (rail plan R4).
    expect(screen.queryByTestId('music-button')).toBeNull()
    await userEvent.click(account)
    const row = screen.getByTestId('menu-music')
    expect(row).toHaveTextContent('Off')
    await userEvent.click(row)
    const panel = screen.getByTestId('music-panel')
    expect(within(panel).getByTestId('music-toggle')).toHaveFocus()

    await userEvent.click(within(panel).getByTestId('music-toggle'))
    await waitFor(() => expect(screen.getByTestId('music-status')).toHaveTextContent('Playing'))
    expect(row).toHaveAttribute('data-playing')
    expect(row).toHaveTextContent('Playing')
    expect(saved()).toMatchObject({ on: true, track: 'piano' })

    await userEvent.click(within(panel).getByTestId('music-track-rain'))
    await waitFor(() => expect(saved().track).toBe('rain'))
    expect(within(panel).getByTestId('music-track-rain')).toBeChecked()

    fireEvent.change(within(panel).getByTestId('music-volume'), { target: { value: '60' } })
    await waitFor(() => expect(saved().volume).toBeCloseTo(0.6))

    // The tracks keep the arrow keys: the menu doesn't take them for its own rows.
    const rain = within(panel).getByTestId('music-track-rain')
    rain.focus()
    await userEvent.keyboard('{ArrowUp}')
    expect(panel).toContainElement(document.activeElement as HTMLElement)
    expect(screen.getByTestId('photo-add')).not.toHaveFocus()

    await userEvent.click(within(panel).getByTestId('music-toggle'))
    await waitFor(() => expect(screen.getByTestId('music-status')).toHaveTextContent('Off'))
    expect(saved().on).toBe(false)

    await userEvent.keyboard('{Escape}')
    expect(screen.queryByTestId('music-panel')).toBeNull()
    expect(account).toHaveFocus()
  })

  it('M6: on a phone, the Apps sheet has a Music row with the same controls', async () => {
    const real = window.matchMedia
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      ...real(query),
      matches: query === MOBILE_QUERY,
    }))
    renderApp('/docs')
    const rail = await screen.findByTestId('app-rail')
    expect(within(rail).queryByTestId('music-button')).toBeNull()
    await userEvent.click(within(rail).getByTestId('apps-menu'))
    const row = within(screen.getByTestId('apps-sheet')).getByTestId('music-row')
    expect(row).toHaveTextContent('Off')
    await userEvent.click(row)
    await userEvent.click(screen.getByTestId('music-toggle'))
    await waitFor(() => expect(row).toHaveTextContent('Playing'))
  })
})
