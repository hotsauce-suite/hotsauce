import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BootError, bootRetryDelay } from './AuthRoot'

describe('BootError', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sessionStorage.clear()
  })
  afterEach(() => vi.useRealTimers())

  it('reloads by itself after a few seconds', () => {
    const reload = vi.fn()
    render(<BootError reload={reload} />)
    expect(screen.getByText(/trying again by itself/i)).toBeTruthy()
    vi.advanceTimersByTime(2_999)
    expect(reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(reload).toHaveBeenCalledOnce()
  })

  it('waits longer after each failed try, up to 30 seconds', () => {
    expect([0, 1, 2, 3, 4, 10].map(bootRetryDelay)).toEqual([3, 6, 12, 24, 30, 30])
    sessionStorage.setItem('hearth:boot-retries', '2')
    const reload = vi.fn()
    render(<BootError reload={reload} />)
    vi.advanceTimersByTime(11_999)
    expect(reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(reload).toHaveBeenCalledOnce()
  })
})
