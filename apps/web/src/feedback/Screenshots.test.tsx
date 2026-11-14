import { act, renderHook, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useScreenshots } from './Screenshots'

// Review fixes for docs/PLAN-feedback-screenshots.md S6/S7, under React StrictMode as in the app.

const png = () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' })
const revoked: string[] = []

beforeEach(() => {
  revoked.length = 0
  let n = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:u${++n}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u) => {
    revoked.push(u)
  })
})

const strict = ({ children }: { children: React.ReactNode }) => <StrictMode>{children}</StrictMode>

describe('useScreenshots', () => {
  it('keeps the page preview usable under StrictMode', async () => {
    const page = png()
    const { result } = renderHook(() => useScreenshots(page), { wrapper: strict })
    await waitFor(() => expect(result.current.pageOffer).not.toBeNull())
    expect(revoked).not.toContain(result.current.pageOffer?.url)
  })

  it('attaches the page picture once however fast it is tapped', async () => {
    const page = png()
    const { result } = renderHook(() => useScreenshots(page), { wrapper: strict })
    await waitFor(() => expect(result.current.pageOffer).not.toBeNull())
    act(() => {
      result.current.attachPage()
      result.current.attachPage()
    })
    expect(result.current.pageOffer).toBeNull()
    await waitFor(() => expect(result.current.shots).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 10))
    expect(result.current.shots).toHaveLength(1)
  })

  it('still holds three at most after a picture is removed', async () => {
    const { result } = renderHook(() => useScreenshots(null), { wrapper: strict })
    act(() => result.current.add([png(), png(), png()]))
    await waitFor(() => expect(result.current.shots).toHaveLength(3))
    const first = result.current.shots[0]?.id ?? 0
    act(() => result.current.remove(first))
    act(() => result.current.add([png(), png()]))
    await waitFor(() => expect(result.current.shots).toHaveLength(3))
    expect(result.current.error).toMatch(/up to 3/)
  })

  it('drops a picture that finishes shrinking after the form was cleared', async () => {
    const { result } = renderHook(() => useScreenshots(null))
    act(() => {
      result.current.add([png()])
      result.current.clear()
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(result.current.shots).toHaveLength(0)
  })

  it('takes no pictures while sending', async () => {
    const { result } = renderHook(() => useScreenshots(null, true))
    act(() => result.current.add([png()]))
    await new Promise((r) => setTimeout(r, 10))
    expect(result.current.shots).toHaveLength(0)
  })

  it('leaves a paste with text alone, so text copied from a sheet still pastes', () => {
    const { result } = renderHook(() => useScreenshots(null))
    const preventDefault = vi.fn()
    act(() =>
      result.current.formProps.onPaste({
        clipboardData: { files: [png()], getData: () => 'A1\tB1' },
        preventDefault,
      } as unknown as React.ClipboardEvent),
    )
    expect(preventDefault).not.toHaveBeenCalled()
    expect(result.current.shots).toHaveLength(0)
  })
})
