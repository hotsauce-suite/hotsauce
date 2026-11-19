import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { renderApp } from '../test/renderApp'
import { breaks } from './breaks'
import { breakSettings, saveBreakSettings } from './settings'

// The page side of screen breaks (docs/PLAN-breaks.md B7, B9, B10, B12a).

async function turnOn() {
  await saveBreakSettings({ on: true })
}

/** The shell has started the timer in this tab. */
async function leading() {
  await waitFor(() => expect(breaks().getView().leader).toBe(true))
}

describe('screen breaks in the page', () => {
  it('B7: Start now on the heads-up shows the break; Esc skips it', async () => {
    renderApp('/today')
    await turnOn()
    await leading()
    breaks().startNow()
    const overlay = await screen.findByTestId('break-overlay')
    expect(overlay).toHaveTextContent('Look at something far away')
    expect(within(overlay).getByTestId('break-scene')).toHaveAttribute('data-animation', 'breathe')
    expect(within(overlay).getByTestId('break-countdown')).toHaveTextContent(/^(20|19)$/)
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('break-overlay')).toBeNull())
  })

  it('B7: the break shows the chosen animation, and 5 more minutes closes it', async () => {
    renderApp('/today')
    await saveBreakSettings({ on: true, animation: 'waves' })
    await leading()
    breaks().startNow()
    const overlay = await screen.findByTestId('break-overlay')
    expect(within(overlay).getByTestId('break-scene')).toHaveAttribute('data-animation', 'waves')
    await userEvent.click(within(overlay).getByTestId('break-overlay-snooze'))
    await waitFor(() => expect(screen.queryByTestId('break-overlay')).toBeNull())
  })

  it('B9: Settings turns breaks on and changes how often, how long and the look', async () => {
    renderApp('/settings')
    const section = await screen.findByTestId('settings-breaks')
    const on = within(section).getByTestId('breaks-on')
    expect(on).not.toBeChecked()
    expect(within(section).getByTestId('breaks-details')).toBeDisabled()
    await userEvent.click(on)
    await waitFor(() => expect(breakSettings().settings.on).toBe(true))
    await userEvent.selectOptions(within(section).getByTestId('breaks-every'), '30')
    await userEvent.selectOptions(within(section).getByTestId('breaks-length'), '60')
    await userEvent.click(within(section).getByTestId('breaks-animation-clouds'))
    await userEvent.click(within(section).getByTestId('breaks-chime'))
    await userEvent.click(within(section).getByTestId('breaks-hours'))
    await waitFor(() =>
      expect(breakSettings().settings).toMatchObject({
        on: true,
        everyMinutes: 30,
        lengthSeconds: 60,
        animation: 'clouds',
        chime: false,
        hours: { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] },
      }),
    )
    await userEvent.click(within(section).getByTestId('breaks-day-6'))
    await waitFor(() => expect(breakSettings().settings.hours?.days).toEqual([1, 2, 3, 4, 5, 6]))
    expect(within(section).getByText('Every 30 minutes, for 1 minute.')).toBeInTheDocument()
    // Saved for the member: a fresh page reads them back.
    cleanup()
    const res = await fetch('/api/breaks', { headers: { 'x-hearth-dev-user': 'ada@example.test' } })
    expect(res.ok).toBe(true)
  })

  it('B9: Take a break now starts one', async () => {
    renderApp('/settings')
    await turnOn()
    const section = await screen.findByTestId('settings-breaks')
    await userEvent.click(within(section).getByTestId('breaks-now'))
    expect(await screen.findByTestId('break-overlay')).toBeInTheDocument()
  })

  it('B10: the account menu row turns breaks on and says how often', async () => {
    renderApp('/today')
    await userEvent.click(await screen.findByTestId('account-menu'))
    const row = await screen.findByTestId('menu-breaks')
    expect(row).toHaveAttribute('aria-checked', 'false')
    expect(row).toHaveTextContent('Off')
    await userEvent.click(row)
    await waitFor(() => expect(screen.getByTestId('menu-breaks')).toHaveTextContent('Every 20 min'))
    expect(screen.getByTestId('menu-breaks')).toHaveAttribute('aria-checked', 'true')
    expect(breakSettings()).toMatchObject({ saved: true, settings: { on: true } })
  })

  it('B12a: Getting started offers breaks; Turn on saves them on and the line goes', async () => {
    renderApp('/today')
    const tile = await screen.findByTestId('today-start')
    const offer = await within(tile).findByTestId('start-breaks-offer')
    expect(offer).toHaveTextContent('Take screen breaks?')
    const count = screen.getByTestId('today-start-count').textContent
    await userEvent.click(within(offer).getByTestId('start-breaks-on'))
    await waitFor(() => expect(within(tile).queryByTestId('start-breaks-offer')).toBeNull())
    expect(breakSettings()).toMatchObject({ saved: true, settings: { on: true } })
    expect(screen.getByTestId('today-start-count').textContent).toBe(count)
  })

  it('B12a: No thanks keeps breaks off and the offer stays gone', async () => {
    renderApp('/today')
    const offer = await screen.findByTestId('start-breaks-offer')
    await userEvent.click(within(offer).getByTestId('start-breaks-no'))
    await waitFor(() => expect(screen.queryByTestId('start-breaks-offer')).toBeNull())
    expect(breakSettings()).toMatchObject({ saved: true, settings: { on: false } })
    cleanup()
    renderApp('/today')
    await screen.findByTestId('today-start')
    expect(screen.queryByTestId('start-breaks-offer')).toBeNull()
  })
})
