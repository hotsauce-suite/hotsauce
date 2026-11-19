import { describe, expect, it, vi } from 'vitest'
import { tasksApi } from '../api/tasks'
import { CHEER, delightOn, reloadDelight, setDelight } from './delight'

// docs/PLAN-rail-account-menu.md, requirement 17.

describe('delight', () => {
  it('R17: ticking off a task cheers, so the pepper hops', async () => {
    const cheered = vi.fn()
    window.addEventListener(CHEER, cheered)
    try {
      const open = (await tasksApi.list()).find((t) => t.status === 'open')
      expect(open).toBeTruthy()
      await tasksApi.complete(open?.space ?? '', open?.id ?? '', 'UTC')
      expect(cheered).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener(CHEER, cheered)
    }
  })

  it('R17: the off switch still works where storage does not', () => {
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('no storage')
    })
    try {
      setDelight(false)
      expect(delightOn()).toBe(false)
      expect(document.documentElement).toHaveAttribute('data-delight', 'off')
    } finally {
      set.mockRestore()
      reloadDelight()
    }
    expect(delightOn()).toBe(true)
  })
})
