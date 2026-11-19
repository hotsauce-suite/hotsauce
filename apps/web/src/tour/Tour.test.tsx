// The first-run tour (docs/PLAN-tour-and-101.md T1-T4, T6, R1).
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_QUERY } from '../hooks/useMediaQuery'
import { SessionProvider } from '../state/session'
import { DESKTOP, IPHONE, pretend } from '../test/devices'
import { mockApi } from '../test/mockServer'
import { stopTour } from './runTour'
import { presentStops, tourStops } from './stops'
import { forgetTourSeen, TourHost } from './TourHost'

/** A page with some of the tour's controls: the rest are missing, so their stops are skipped. */
function Page() {
  return (
    <>
      <nav data-testid="app-rail">rail</nav>
      <h1 data-testid="today-greeting">Good morning</h1>
      <button type="button" data-testid="launcher-button">
        Apps
      </button>
      <button type="button" data-testid="account-menu">
        You
      </button>
      <TourHost ready find={(id) => document.querySelector(`[data-testid="${id}"]`)} />
    </>
  )
}

function renderAt(path = '/today') {
  const router = createMemoryRouter(
    [
      {
        path: '/today',
        element: (
          <SessionProvider>
            <Page />
          </SessionProvider>
        ),
      },
    ],
    { initialEntries: [path] },
  )
  render(<RouterProvider router={router} />)
  return router
}

afterEach(() => {
  act(() => stopTour())
  forgetTourSeen()
  vi.restoreAllMocks()
})

describe('the stops', () => {
  it('names the workspace and speaks to the Mac app only inside it (T4)', () => {
    const web = tourStops({ name: 'Acme', mac: false })
    const mac = tourStops({ name: 'Acme', mac: true })
    expect(web).toHaveLength(12)
    expect(web.find((s) => s.id === 'ask')?.title).toBe('Ask Acme')
    expect(web.find((s) => s.id === 'dictate')?.body).toContain('Get the Mac app')
    expect(mac.find((s) => s.id === 'dictate')?.body).toContain('right Option')
    expect(web.find((s) => s.id === 'menu')?.body).not.toContain('This Mac')
    expect(mac.find((s) => s.id === 'menu')?.body).toContain('This Mac')
  })

  it('leaves out a stop whose control is not on screen (T2)', () => {
    const shown = presentStops(tourStops({ name: 'Acme', mac: false }), (id) =>
      id === 'app-rail' ? document.body : null,
    )
    expect(shown.map((s) => s.id)).toEqual(['rail', 'search', 'dictate'])
  })
})

describe('the welcome card', () => {
  it('greets a member who has not seen it, and Not now counts as seen (T1, T3)', async () => {
    pretend({ ua: DESKTOP })
    mockApi().tour.seen = false
    renderAt()
    expect(await screen.findByTestId('tour-welcome')).toHaveTextContent('Welcome to')
    await userEvent.click(screen.getByTestId('tour-not-now'))
    expect(screen.queryByTestId('tour-welcome')).toBeNull()
    await waitFor(() => expect(mockApi().tour.seen).toBe(true))
  })

  it('says nothing to a member who has seen it (T1)', async () => {
    pretend({ ua: DESKTOP })
    renderAt()
    await screen.findByTestId('today-greeting')
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByTestId('tour-welcome')).toBeNull()
  })

  it('waits for a computer: never on a phone (T1)', async () => {
    pretend({ ua: IPHONE, touch: 5, queries: [MOBILE_QUERY] })
    mockApi().tour.seen = false
    renderAt()
    await screen.findByTestId('today-greeting')
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.queryByTestId('tour-welcome')).toBeNull()
    expect(mockApi().tour.seen).toBe(false)
  })

  it('Escape is Not now (T3, T6)', async () => {
    pretend({ ua: DESKTOP })
    mockApi().tour.seen = false
    renderAt()
    await screen.findByTestId('tour-welcome')
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByTestId('tour-welcome')).toBeNull()
    await waitFor(() => expect(mockApi().tour.seen).toBe(true))
  })

  it('comes back with ?tour=1 even when seen, and drops it from the address (R1)', async () => {
    pretend({ ua: DESKTOP })
    const router = renderAt('/today?tour=1')
    expect(await screen.findByTestId('tour-welcome')).toBeInTheDocument()
    await waitFor(() => expect(router.state.location.search).toBe(''))
  })
})

describe('the tour', () => {
  it('walks the stops on screen in order, Back goes back, the last says Done (T2, T3)', async () => {
    pretend({ ua: DESKTOP })
    mockApi().tour.seen = false
    renderAt()
    await userEvent.click(await screen.findByTestId('tour-start'))
    await waitFor(() => expect(mockApi().tour.seen).toBe(true))

    const stop = async (title: string) =>
      waitFor(() => expect(screen.getByTestId('tour-stop')).toHaveTextContent(title))
    await stop('Your apps')
    await userEvent.click(screen.getByTestId('tour-next'))
    await stop('Today is your home page')
    await userEvent.click(screen.getByTestId('tour-back'))
    await stop('Your apps')
    // On this page: rail, Today, launcher, ⌘K, Dictate, the menu.
    for (const title of [
      'Today is your home page',
      'Every app, and your pins',
      'Find anything with ⌘K',
      'Dictate anywhere',
      'Your menu',
    ]) {
      await userEvent.click(screen.getByTestId('tour-next'))
      await stop(title)
    }
    expect(screen.getByTestId('tour-stop')).toHaveTextContent('Your menu')
    expect(screen.getByTestId('tour-stop')).toHaveTextContent('6 of 6')
    expect(screen.getByTestId('tour-next')).toHaveTextContent('Done')
    await userEvent.click(screen.getByTestId('tour-next'))
    await waitFor(() => expect(screen.queryByTestId('tour-stop')).toBeNull())
  })

  it('Escape ends it (T3, T6)', async () => {
    pretend({ ua: DESKTOP })
    mockApi().tour.seen = false
    renderAt()
    await userEvent.click(await screen.findByTestId('tour-start'))
    await waitFor(() => expect(screen.getByTestId('tour-stop')).toBeInTheDocument())
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('tour-stop')).toBeNull())
  })

  it('can be finished by keyboard: Next has focus, Enter and the arrows move (T6)', async () => {
    pretend({ ua: DESKTOP })
    mockApi().tour.seen = false
    renderAt()
    await userEvent.click(await screen.findByTestId('tour-start'))
    await waitFor(() => expect(screen.getByTestId('tour-next')).toHaveFocus())
    await userEvent.keyboard('{Enter}')
    await waitFor(() =>
      expect(screen.getByTestId('tour-stop')).toHaveTextContent('Today is your home page'),
    )
    await userEvent.keyboard('{ArrowLeft}')
    await waitFor(() => expect(screen.getByTestId('tour-stop')).toHaveTextContent('Your apps'))
    await userEvent.keyboard('{ArrowRight}')
    await waitFor(() =>
      expect(screen.getByTestId('tour-stop')).toHaveTextContent('Today is your home page'),
    )
  })

  it('leaves the keys to another dialog open over it', async () => {
    pretend({ ua: DESKTOP })
    mockApi().tour.seen = false
    renderAt()
    await userEvent.click(await screen.findByTestId('tour-start'))
    await waitFor(() => expect(screen.getByTestId('tour-stop')).toHaveTextContent('Your apps'))
    const other = document.createElement('div')
    other.setAttribute('role', 'dialog')
    document.body.append(other)
    // jsdom has no layout: say the dialog is on screen.
    vi.spyOn(other, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList)
    await userEvent.keyboard('{ArrowRight}{Escape}')
    expect(screen.getByTestId('tour-stop')).toHaveTextContent('Your apps')
    other.remove()
  })

  it('never starts once Today is left while it loads', async () => {
    const { runTour } = await import('./runTour')
    const onEnd = vi.fn()
    const started = runTour(
      [{ id: 'search', target: null, title: 'Find anything', body: 'x' }],
      () => null,
      onEnd,
    )
    stopTour()
    await started
    expect(onEnd).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('tour-stop')).toBeNull()
  })
})
