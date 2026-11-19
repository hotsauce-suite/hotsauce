import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cheer, DELIGHT_KEY, reloadDelight } from '../lib/delight'
import { chooseTheme } from '../lib/theme'
import { renderApp } from '../test/renderApp'
import { asleepAt, greeting, Mascot } from './Mascot'

// The pepper in the left bar (docs/PLAN-rail-account-menu.md, requirement 17).

const at = (hour: number) => new Date(2026, 10, 19, hour, 30)

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  chooseTheme('system')
})

function lessMotion(on: boolean) {
  const real = window.matchMedia
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    ...real(query),
    matches: on && query.includes('prefers-reduced-motion'),
  }))
}

describe('the pepper', () => {
  it('R17: sits at the foot of the rail, and hops when something gets done', async () => {
    renderApp('/docs')
    const pepper = await screen.findByTestId('rail-mascot')
    expect(screen.getByTestId('app-rail')).toContainElement(pepper)
    expect(pepper).toHaveAttribute('aria-hidden', 'true')
    expect(pepper).not.toHaveAttribute('data-hop')
    vi.setSystemTime(at(10))
    act(() => cheer())
    expect(pepper).toHaveAttribute('data-hop')
    await waitFor(() => expect(pepper).not.toHaveAttribute('data-hop'), { timeout: 2000 })
  })

  it('R17: keeps still when the device asks for less motion', () => {
    vi.useFakeTimers({ now: at(10) })
    lessMotion(true)
    render(<Mascot name="Ada Lovelace" />)
    act(() => cheer())
    expect(screen.getByTestId('rail-mascot')).not.toHaveAttribute('data-hop')
  })

  it('R17: sleeps at night and wears sunglasses in a dark theme', () => {
    vi.useFakeTimers({ now: at(23) })
    const night = render(<Mascot name="Ada Lovelace" />)
    const asleep = screen.getByTestId('rail-mascot')
    expect(asleep).toHaveAttribute('data-mood', 'asleep')
    act(() => cheer())
    expect(asleep).not.toHaveAttribute('data-hop')
    night.unmount()

    vi.setSystemTime(at(14))
    render(<Mascot name="Ada Lovelace" />)
    const awake = screen.getByTestId('rail-mascot')
    expect(awake).toHaveAttribute('data-mood', 'awake')
    expect(awake).not.toHaveAttribute('data-shades')
    act(() => chooseTheme('dark'))
    expect(awake).toHaveAttribute('data-shades')
  })

  it('R17: greets by the time of day', () => {
    expect(asleepAt(at(5))).toBe(true)
    expect(asleepAt(at(6))).toBe(false)
    expect(asleepAt(at(22))).toBe(true)
    expect(greeting(at(9), 'Ada Lovelace').title).toBe('Good morning, Ada')
    expect(greeting(at(15), undefined).title).toBe('Good afternoon')
    expect(greeting(at(19), 'Ada').title).toBe('Good evening, Ada')
    expect(greeting(at(23), 'Ada').title).toMatch(/asleep/)
  })

  it('R17: Settings, Appearance turns it off, and the choice is kept', async () => {
    renderApp('/settings/appearance')
    await screen.findByTestId('rail-mascot')
    const off = await screen.findByTestId('delight-switch')
    expect(off).toBeChecked()
    await userEvent.click(off)
    expect(screen.queryByTestId('rail-mascot')).toBeNull()
    expect(localStorage.getItem(DELIGHT_KEY)).toBe('off')
    expect(document.documentElement).toHaveAttribute('data-delight', 'off')
    await userEvent.click(off)
    expect(await screen.findByTestId('rail-mascot')).toBeInTheDocument()
    expect(localStorage.getItem(DELIGHT_KEY)).toBeNull()
    reloadDelight()
  })
})
