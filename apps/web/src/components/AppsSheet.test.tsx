import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import { MOBILE_QUERY } from '../hooks/useMediaQuery'
import { renderApp } from '../test/renderApp'

afterEach(() => vi.restoreAllMocks())

/** Renders as a phone: the shell's mobile query matches. */
function phone() {
  const real = window.matchMedia
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    ...real(query),
    matches: query === MOBILE_QUERY,
  }))
}

const barIds = () =>
  [...screen.getByTestId('app-rail').querySelectorAll('a, button')].map((el) =>
    el.getAttribute('data-testid'),
  )

async function openEditor() {
  phone()
  renderApp('/docs')
  await userEvent.click(await screen.findByTestId('apps-menu'))
  const sheet = screen.getByTestId('apps-sheet')
  await userEvent.click(within(sheet).getByTestId('apps-sheet-edit'))
  return sheet
}

// Choosing the phone tab bar's apps from the Apps sheet (docs/PLAN-phone-tab-bar.md R4, R5).
describe('editing the tab bar', () => {
  it('adds and removes apps, and the bar and the server follow', async () => {
    const sheet = await openEditor()
    expect(within(sheet).getByTestId('apps-sheet-edit')).toHaveTextContent('Done')
    const bar = within(sheet).getByTestId('apps-sheet-bar')
    expect([...bar.querySelectorAll('li')].map((li) => li.dataset.pinId)).toEqual([
      'today',
      'docs',
      'tasks',
      'meetings',
    ])
    expect(within(sheet).getByTestId('apps-sheet-toggle-docs')).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    await userEvent.click(within(sheet).getByTestId('apps-sheet-toggle-clips'))
    await waitFor(() =>
      expect(barIds()).toEqual([
        'app-switch-today',
        'app-switch-docs',
        'app-switch-tasks',
        'app-switch-meetings',
        'app-switch-clips',
        'apps-menu',
      ]),
    )
    await userEvent.click(within(sheet).getByTestId('apps-sheet-remove-docs'))
    await waitFor(async () =>
      expect((await api.phonePins()).pins).toEqual(['today', 'tasks', 'meetings', 'clips']),
    )
    expect(barIds()).not.toContain('app-switch-docs')
    // Editing stays on until Done; then the sheet lists the apps again.
    await userEvent.click(within(sheet).getByTestId('apps-sheet-edit'))
    expect(within(sheet).getByTestId('apps-sheet-docs')).toBeInTheDocument()
  })

  it('holds five apps at most, and allows none', async () => {
    await api.setPhonePins(['today', 'docs', 'tasks', 'meetings', 'clips'])
    const sheet = await openEditor()
    await waitFor(() =>
      expect(within(sheet).getByTestId('apps-sheet-help')).toHaveTextContent(
        'The tab bar holds 5 apps. Remove one to add another.',
      ),
    )
    expect(within(sheet).getByTestId('apps-sheet-toggle-dictate')).toBeDisabled()
    expect(within(sheet).getByTestId('apps-sheet-toggle-clips')).toBeEnabled()

    for (const id of ['today', 'docs', 'tasks', 'meetings', 'clips']) {
      await userEvent.click(within(sheet).getByTestId(`apps-sheet-remove-${id}`))
    }
    await waitFor(() => expect(barIds()).toEqual(['apps-menu']))
    expect(within(sheet).getByTestId('apps-sheet-bar')).toHaveTextContent(
      'Only Apps is on the bar.',
    )
    await waitFor(async () => expect((await api.phonePins()).pins).toEqual([]))
  })

  it('reorders by drag and by Alt and an arrow key', async () => {
    const sheet = await openEditor()
    const bar = within(sheet).getByTestId('apps-sheet-bar')
    const order = () => [...bar.querySelectorAll('li')].map((li) => li.dataset.pinId)

    within(sheet).getByTestId('apps-sheet-remove-tasks').focus()
    await userEvent.keyboard('{Alt>}{ArrowLeft}{/Alt}')
    await waitFor(() => expect(order()).toEqual(['today', 'tasks', 'docs', 'meetings']))

    // Drag Meetings onto Today: it moves to the front, and the drop isn't a tap that removes it.
    const meetings = within(sheet).getByTestId('apps-sheet-bar-meetings')
    const today = within(sheet).getByTestId('apps-sheet-bar-today')
    const real = document.elementFromPoint
    document.elementFromPoint = () => today
    fireEvent.pointerDown(meetings, { pointerId: 1, button: 0, clientX: 200, clientY: 10 })
    fireEvent.pointerMove(meetings, { pointerId: 1, clientX: 20, clientY: 10 })
    fireEvent.pointerUp(meetings, { pointerId: 1, clientX: 20, clientY: 10 })
    fireEvent.click(within(sheet).getByTestId('apps-sheet-remove-meetings'))
    document.elementFromPoint = real
    await waitFor(async () =>
      expect((await api.phonePins()).pins).toEqual(['meetings', 'today', 'tasks', 'docs']),
    )
    expect(order()).toEqual(['meetings', 'today', 'tasks', 'docs'])
  })
})
