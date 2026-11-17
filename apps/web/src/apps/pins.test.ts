import { act, renderHook, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'
import { api } from '../api/client'
import { server } from '../test/mockServer'
import {
  DEFAULT_PHONE_PINS,
  DEFAULT_PINS,
  forgetPins,
  savePhonePins,
  savePins,
  usePhonePins,
  usePins,
} from './pins'

describe('the pins store', () => {
  it('keeps a save made before the first load answers', async () => {
    let answer: (value: Response) => void = () => {}
    server.use(
      http.get('/api/pins', () => new Promise<Response>((resolve) => (answer = resolve)), {
        once: true,
      }),
    )
    const { result } = renderHook(() => usePins())
    expect(result.current).toEqual(DEFAULT_PINS)
    await act(() => savePins(['notes']))
    // The server's older answer arrives after the save: it is dropped.
    answer(HttpResponse.json({ pins: null }))
    await new Promise((r) => setTimeout(r, 20))
    expect(result.current).toEqual(['notes'])
    expect((await api.pins()).pins).toEqual(['notes'])
  })

  it('goes back to what the server has when a save fails', async () => {
    await api.setPins(['today', 'docs'])
    const { result } = renderHook(() => usePins())
    await waitFor(() => expect(result.current).toEqual(['today', 'docs']))
    server.use(http.put('/api/pins', () => HttpResponse.json({}, { status: 500 }), { once: true }))
    await act(() => savePins(['files']).catch(() => {}))
    await waitFor(() => expect(result.current).toEqual(['today', 'docs']))
  })

  it('saves in click order, and sign-out forgets the list', async () => {
    const { result } = renderHook(() => usePins())
    await act(async () => {
      await Promise.all([savePins(['a']), savePins(['a', 'b']), savePins(['b'])])
    })
    expect((await api.pins()).pins).toEqual(['b'])
    act(() => forgetPins())
    expect(result.current).toEqual(DEFAULT_PINS)
    expect(localStorage.getItem('hearth.pins')).toBeNull()
  })

  it("keeps the phone list apart from the rail's, and sign-out forgets both", async () => {
    const rail = renderHook(() => usePins())
    const phone = renderHook(() => usePhonePins())
    expect(phone.result.current).toEqual(DEFAULT_PHONE_PINS)
    await act(() => savePhonePins(['tasks', 'chat']))
    expect(phone.result.current).toEqual(['tasks', 'chat'])
    expect(rail.result.current).toEqual(DEFAULT_PINS)
    expect((await api.phonePins()).pins).toEqual(['tasks', 'chat'])
    expect((await api.pins()).pins).toBeNull()
    act(() => forgetPins())
    expect(phone.result.current).toEqual(DEFAULT_PHONE_PINS)
    expect(localStorage.getItem('hotsauce.phone-pins')).toBeNull()
  })
})
