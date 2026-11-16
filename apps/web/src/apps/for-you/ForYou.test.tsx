import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { forYouApi } from '../../api/forYou'
import { MOBILE_QUERY } from '../../hooks/useMediaQuery'
import { renderApp } from '../../test/renderApp'

afterEach(() => vi.restoreAllMocks())

// For you in the web app (docs/PLAN-comments.md R12 to R16) against the MSW mock, whose sample
// conversations mention the test member (Ada) on the Q4 plan and on the pilot report task.

const items = () => screen.findAllByTestId('for-you-item')

describe('For you', () => {
  it('lists each item that mentions me, newest first, and the rail counts them (R12, R13)', async () => {
    renderApp('/for-you')
    const rows = await items()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Ship the pilot report')
    expect(rows[0]).toHaveTextContent('Priya Natarajan mentioned you')
    expect(rows[1]).toHaveTextContent('Q4 plan')
    expect(rows[1]).toHaveTextContent('can we move this to Dec 1?')
    const rail = screen.getByTestId('app-rail')
    const entry = within(rail).getByTestId('app-switch-for-you')
    expect(within(entry).getByTestId('rail-count')).toHaveTextContent('2')
    expect(entry).toHaveAccessibleName('For you, 2 new')
  })

  it('opening an item marks it seen and lowers the count, and it stays listed (R14)', async () => {
    renderApp('/for-you')
    const [first] = await items()
    await userEvent.click(within(first as HTMLElement).getByTestId('for-you-open'))
    await screen.findByTestId('comments')
    const rail = screen.getByTestId('app-rail')
    await waitFor(() => expect(within(rail).getByTestId('rail-count')).toHaveTextContent('1'))
    const view = await forYouApi.list()
    expect(view.items).toHaveLength(2)
    expect(view.items.map((i) => i.unseen)).toEqual([false, true])
  })

  it('Done takes it off with Undo; Later hides it until 9 AM (R15, R16)', async () => {
    renderApp('/for-you')
    const [first] = await items()
    await userEvent.click(within(first as HTMLElement).getByTestId('for-you-done'))
    const toast = await screen.findByTestId('for-you-toast')
    expect(toast).toHaveTextContent('Done: Ship the pilot report')
    await waitFor(async () => expect(await items()).toHaveLength(1))
    await userEvent.click(within(toast).getByTestId('for-you-undo'))
    await waitFor(async () => expect(await items()).toHaveLength(2))

    const [again] = await items()
    await userEvent.click(within(again as HTMLElement).getByTestId('for-you-later'))
    await userEvent.click(await screen.findByTestId('for-you-later-monday'))
    expect(await screen.findByTestId('for-you-toast')).toHaveTextContent('Back next Monday at 9 AM')
    await waitFor(async () => expect(await items()).toHaveLength(1))
  })

  it('shows on Today as a tile', async () => {
    renderApp('/today')
    const tile = await screen.findByTestId('today-for-you')
    expect(within(tile).getByText('For you (2 new)')).toBeInTheDocument()
    expect(await within(tile).findAllByTestId('for-you-item')).toHaveLength(2)
  })

  it('on a phone, the count is on the Today button', async () => {
    const real = window.matchMedia
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      ...real(query),
      matches: query === MOBILE_QUERY,
    }))
    renderApp('/docs')
    const rail = await screen.findByTestId('app-rail')
    const today = within(rail).getByTestId('app-switch-today')
    await waitFor(() => expect(within(today).getByTestId('rail-count')).toHaveTextContent('2'))
  })
})
