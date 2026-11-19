import { act, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SWITCH_FX_KEY } from '../lib/switchFx'
import { useSwitchFx } from './useSwitchFx'

let setApp: (id: string | null) => void = () => {}
function Harness({ first }: { first: string | null }) {
  const [app, set] = useState<string | null>(first)
  setApp = set
  useSwitchFx(app)
  return null
}

const ripples = () => document.querySelectorAll('[data-testid="switch-ripple"]')

beforeEach(() => localStorage.removeItem(SWITCH_FX_KEY))
afterEach(() => {
  for (const el of ripples()) el.remove()
  vi.restoreAllMocks()
})

describe('useSwitchFx', () => {
  it('ripples from the click that switched tools, not on the first page or within a tool', () => {
    render(<Harness first="docs" />)
    expect(ripples()).toHaveLength(0)
    act(() => setApp('docs'))
    expect(ripples()).toHaveLength(0)
    document.dispatchEvent(new MouseEvent('pointerdown', { clientX: 30, clientY: 200 }))
    act(() => setApp('meetings'))
    expect(ripples()).toHaveLength(1)
    expect((ripples()[0] as HTMLElement).style.left).toBe(`${30 - 180}px`)
  })

  it('does not ripple coming back to the same tool from Settings', () => {
    render(<Harness first="docs" />)
    act(() => setApp(null))
    document.dispatchEvent(new MouseEvent('pointerdown', { clientX: 30, clientY: 200 }))
    act(() => setApp('docs'))
    expect(ripples()).toHaveLength(0)
    act(() => setApp(null))
    act(() => setApp('tasks'))
    expect(ripples()).toHaveLength(1)
  })

  it('a key press forgets the last click, so a keyboard switch does not start at it', () => {
    const icon = document.createElement('a')
    icon.dataset.testid = 'app-switch-tasks'
    icon.getBoundingClientRect = () => ({ left: 0, top: 100, width: 50, height: 40 }) as DOMRect
    document.body.appendChild(icon)
    render(<Harness first="docs" />)
    document.dispatchEvent(new MouseEvent('pointerdown', { clientX: 300, clientY: 300 }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g' }))
    act(() => setApp('tasks'))
    expect((ripples()[0] as HTMLElement).style.left).toBe(`${25 - 180}px`)
    icon.remove()
  })

  it('stays still when the member turned the ripple off', () => {
    localStorage.setItem(SWITCH_FX_KEY, JSON.stringify({ ripple: false, sound: false }))
    render(<Harness first="docs" />)
    document.dispatchEvent(new MouseEvent('pointerdown', { clientX: 30, clientY: 200 }))
    act(() => setApp('tasks'))
    expect(ripples()).toHaveLength(0)
  })

  it('stays still when the device asks for reduced motion', () => {
    const real = window.matchMedia
    vi.spyOn(window, 'matchMedia').mockImplementation((q: string) => ({
      ...real(q),
      matches: q === '(prefers-reduced-motion: reduce)',
    }))
    render(<Harness first="docs" />)
    document.dispatchEvent(new MouseEvent('pointerdown', { clientX: 30, clientY: 200 }))
    act(() => setApp('tasks'))
    expect(ripples()).toHaveLength(0)
  })
})
