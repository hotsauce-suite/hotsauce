import { describe, expect, it, vi } from 'vitest'
import { registerOpenDoc, saveOpenDocUnder } from './openDoc'

describe('saveOpenDocUnder', () => {
  it('commits the open doc before it, or its folder, moves; leaves others alone', async () => {
    const commit = vi.fn(async () => 'committed' as const)
    const off = registerOpenDoc('team', 'docs/plans/q4.md', commit)
    expect(await saveOpenDocUnder('team', 'docs/other.md')).toBe(true)
    expect(await saveOpenDocUnder('ada', 'docs/plans/q4.md')).toBe(true)
    expect(await saveOpenDocUnder('team', 'docs/plan')).toBe(true)
    expect(commit).not.toHaveBeenCalled()
    expect(await saveOpenDocUnder('team', 'docs/plans/q4.md')).toBe(true)
    expect(await saveOpenDocUnder('team', 'docs/plans')).toBe(true)
    expect(commit).toHaveBeenCalledTimes(2)
    off()
    expect(await saveOpenDocUnder('team', 'docs/plans')).toBe(true)
    expect(commit).toHaveBeenCalledTimes(2)
  })

  it('says no when the save conflicted or failed', async () => {
    const off = registerOpenDoc('team', 'docs/a.md', async () => 'conflict')
    expect(await saveOpenDocUnder('team', 'docs/a.md')).toBe(false)
    off()
    const off2 = registerOpenDoc('team', 'docs/a.md', async () => 'error')
    expect(await saveOpenDocUnder('team', 'docs')).toBe(false)
    off2()
  })
})
