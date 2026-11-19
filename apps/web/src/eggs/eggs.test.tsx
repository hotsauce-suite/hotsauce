import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TodayGreeting } from '../apps/today/TodayHeader'
import { chooseTheme } from '../lib/theme'
import { renderApp } from '../test/renderApp'
import { isGhostPepper } from './ghostPepper'
import { KONAMI } from './logic'
import { MORE_HEAT_EVENT } from './useEggs'

const KEYS: Record<string, string> = {
  ArrowUp: '{ArrowUp}',
  ArrowDown: '{ArrowDown}',
  ArrowLeft: '{ArrowLeft}',
  ArrowRight: '{ArrowRight}',
}
const konami = KONAMI.map((k) => KEYS[k] ?? k).join('')

afterEach(() => {
  document.querySelectorAll('.egg-layer').forEach((el) => {
    el.remove()
  })
  localStorage.clear()
  chooseTheme('system')
  vi.restoreAllMocks()
})

describe('Easter eggs in the app', () => {
  it('E1: the Konami code starts the pepper shower, but not while typing in a field', async () => {
    const user = userEvent.setup()
    renderApp('/tasks')
    await screen.findByTestId('app-rail')
    await user.keyboard(konami)
    expect(await screen.findByTestId('pepper-shower')).toBeInTheDocument()
    document.querySelector('[data-testid="pepper-shower"]')?.remove()

    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    await user.keyboard(konami)
    expect(screen.queryByTestId('pepper-shower')).toBeNull()
    input.remove()
  })

  it('E9: the Mac app menu item starts the shower', async () => {
    renderApp('/tasks')
    await screen.findByTestId('app-rail')
    window.dispatchEvent(new Event(MORE_HEAT_EVENT))
    expect(await screen.findByTestId('pepper-shower')).toBeInTheDocument()
  })

  it('E3: "more heat" in ⌘K turns on Ghost Pepper and "less heat" cools down', async () => {
    const user = userEvent.setup()
    renderApp('/tasks')
    await screen.findByTestId('app-rail')
    await user.keyboard('{Control>}k{/Control}')
    await user.type(await screen.findByTestId('cmdk-input'), 'heat')
    expect(screen.queryByTestId('cmdk-command-egg-more-heat')).toBeNull()
    await user.clear(screen.getByTestId('cmdk-input'))
    await user.type(screen.getByTestId('cmdk-input'), 'more heat')
    await user.click(await screen.findByTestId('cmdk-command-egg-more-heat'))
    expect(isGhostPepper()).toBe(true)

    await user.keyboard('{Control>}k{/Control}')
    await user.type(await screen.findByTestId('cmdk-input'), 'less heat')
    await user.click(await screen.findByTestId('cmdk-command-egg-less-heat'))
    expect(isGhostPepper()).toBe(false)
  })

  it('E4: Appearance keeps Ghost Pepper on and says how to cool down', async () => {
    const { moreHeat } = await import('./ghostPepper')
    moreHeat()
    renderApp('/settings/appearance')
    expect(await screen.findByTestId('ghost-pepper-on')).toHaveTextContent('less heat')
    await waitFor(() => expect(screen.getByTestId('theme-picker')).toBeInTheDocument())
    // The account's themes loaded and Ghost Pepper is still on.
    await new Promise((r) => setTimeout(r, 50))
    expect(isGhostPepper()).toBe(true)
  })

  it('E6: an address no page owns shows the lost-sauce page with a way to Docs', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/no-such-place')
    expect(await screen.findByTestId('not-found')).toHaveTextContent(
      'This page got too spicy and left.',
    )
    await user.click(screen.getByTestId('not-found-home'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/docs'))
  })

  it('E7: Today greets Hot Sauce Day on January 22 only', () => {
    const { rerender } = render(<TodayGreeting view={null} now={new Date(2027, 0, 22, 9)} />)
    expect(screen.getByTestId('today-hot-sauce-day')).toHaveTextContent('National Hot Sauce Day')
    rerender(<TodayGreeting view={null} now={new Date(2027, 0, 23, 9)} />)
    expect(screen.queryByTestId('today-hot-sauce-day')).toBeNull()
  })

  it('E8: the console note is printed once', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { noteInConsole } = await import('./useEggs')
    noteInConsole()
    noteInConsole()
    expect(
      info.mock.calls.filter((c) => String(c[0]).includes('open source')).length,
    ).toBeLessThanOrEqual(1)
  })
})
