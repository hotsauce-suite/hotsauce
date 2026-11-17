import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { DICTATIONS_CHANGED, parseMacDictations } from '../../lib/macDictations'
import { FakeMac, sampleDictations } from '../../test/fakeMac'
import { duration, MacDictations } from './MacDictations'

// docs/PLAN-dictations-page.md R1–R5, R9, against a stand-in for the Mac app's bridge.

const withHistory = (history = sampleDictations()) => {
  const mac = new FakeMac()
  mac.dictations = history
  return mac
}

describe('Dictate → On this Mac', () => {
  it('is not there in a browser, or in a Mac app that has no history to share (R1)', async () => {
    const { container } = render(<MacDictations bridge={null} />)
    expect(container).toBeEmptyDOMElement()

    const older = new FakeMac()
    render(<MacDictations bridge={older} />)
    await waitFor(() => expect(older.requests.some((r) => r.type === 'dictations')).toBe(true))
    await waitFor(() => expect(screen.queryByTestId('mac-dictations')).toBeNull())
  })

  it('shows the Mac’s numbers, sources, month and newest dictations (R1–R4)', async () => {
    const mac = withHistory()
    render(<MacDictations bridge={mac} />)
    const section = await screen.findByTestId('mac-dictations')
    const tiles = await within(section).findByTestId('mac-dictations-tiles')
    // 30 days by default: two of the three dictations.
    expect(within(tiles).getByText('2 dictations')).toBeInTheDocument()
    expect(within(section).getByTestId('mac-dictations-sources')).toHaveTextContent('Slack')
    expect(within(section).getByTestId('mac-dictations-month')).toHaveTextContent('1 active day')

    const list = within(section).getByTestId('mac-dictations-list')
    const rows = within(list).getAllByRole('listitem')
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Shipping Dictate'),
      expect.stringContaining('Draft the hiring plan'),
      expect.stringContaining('Running ten minutes late'),
    ])
    expect(rows[1]).toHaveTextContent('as spoken')
    expect(rows[2]).toHaveTextContent('on this Mac')
    // The icon the Mac drew, for apps it has one for.
    expect(rows[0]?.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png/)
  })

  it('counts the range picked, and searches the text and app (R2)', async () => {
    const user = userEvent.setup()
    const mac = withHistory()
    render(<MacDictations bridge={mac} />)
    const tiles = await screen.findByTestId('mac-dictations-tiles')
    await user.click(screen.getByRole('button', { name: '7 days' }))
    await waitFor(() => expect(within(tiles).getByText('2 dictations')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'All' }))
    await waitFor(() => expect(within(tiles).getByText('3 dictations')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
    expect(mac.requests.filter((r) => r.type === 'dictations').at(-1)).toEqual({
      type: 'dictations',
      range: 'all',
      search: '',
    })

    await user.type(screen.getByRole('searchbox', { name: 'Search dictations' }), 'notes')
    await waitFor(() =>
      expect(
        within(screen.getByTestId('mac-dictations-list')).getAllByRole('listitem'),
      ).toHaveLength(1),
    )
    await user.clear(screen.getByRole('searchbox', { name: 'Search dictations' }))
    await user.type(screen.getByRole('searchbox', { name: 'Search dictations' }), 'zebra')
    expect(await screen.findByTestId('mac-dictations-empty')).toHaveTextContent(
      'Nothing matches “zebra”',
    )
  })

  it('copies and pastes through the Mac (R3)', async () => {
    const user = userEvent.setup()
    const mac = withHistory()
    render(<MacDictations bridge={mac} />)
    await screen.findByTestId('mac-dictations-list')
    await user.click(screen.getAllByRole('button', { name: 'Copy dictation from Slack' })[0]!)
    expect(mac.copied).toEqual(['Shipping Dictate to the team today'])
    expect(await screen.findByText('Copied')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Paste dictation from Notes' }))
    expect(mac.pasted).toEqual(['Draft the hiring plan'])

    // Cleared on the Mac in the meantime: says so, does nothing.
    mac.dictations = []
    await user.click(screen.getByRole('button', { name: 'Paste dictation from Notes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('couldn’t')
    expect(mac.pasted).toHaveLength(1)
  })

  it('reads again when the Mac says its history changed, and on focus (R5, R9)', async () => {
    const mac = withHistory([])
    render(<MacDictations bridge={mac} />)
    expect(await screen.findByTestId('mac-dictations-empty')).toHaveTextContent(
      'Hold your dictation shortcut',
    )
    mac.dictations = sampleDictations()
    act(() => {
      window.dispatchEvent(new Event(DICTATIONS_CHANGED))
    })
    expect(await screen.findByTestId('mac-dictations-list')).toBeInTheDocument()
    mac.dictations = []
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(await screen.findByTestId('mac-dictations-empty')).toBeInTheDocument()
  })
})

describe('parseMacDictations', () => {
  const good = () => ({
    range: 'week',
    stats: {
      dictations: 1,
      totalWords: 3,
      timeSavedMinutes: 0.05,
      averageWPM: 120,
      topApps: [{ name: 'Slack', bundle: null, words: 3 }],
    },
    month: {
      start: 1_700_000_000_000,
      leadingBlanks: 2,
      days: [{ words: 3, level: 4 }],
      activeDays: 1,
    },
    total: 1,
    matched: 1,
    records: [
      {
        id: 'x',
        date: 1_700_000_000_000,
        text: 'one two three',
        app: null,
        bundle: null,
        cleaned: true,
        onDevice: false,
      },
    ],
    icons: { a: 'data:image/png;base64,AAAA', b: 'https://example.com/x.png' },
  })

  it('keeps only data-URL icons the Mac drew', () => {
    expect(parseMacDictations(good())?.icons).toEqual({ a: 'data:image/png;base64,AAAA' })
  })

  it('refuses any answer with a field of the wrong kind', () => {
    const paths: [string[], unknown][] = [
      [['range'], 'year'],
      [['total'], -1],
      [['stats', 'totalWords'], 1.5],
      [['stats', 'timeSavedMinutes'], Number.NaN],
      [['month', 'leadingBlanks'], 7],
      [['month', 'days'], [{ words: 1, level: 5 }]],
      [['records'], [{ id: 'x' }]],
      [['icons'], []],
    ]
    for (const [path, value] of paths) {
      const reply = good() as Record<string, unknown>
      let at = reply
      for (const key of path.slice(0, -1)) at = at[key] as Record<string, unknown>
      at[path.at(-1)!] = value
      expect(parseMacDictations(reply), path.join('.')).toBeNull()
    }
  })

  it('never throws, whatever the Mac answers', () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const parsed = parseMacDictations(value)
        expect(parsed === null || typeof parsed === 'object').toBe(true)
      }),
    )
  })
})

describe('duration', () => {
  it('reads like the Mac window did', () => {
    expect(duration(0.5)).toBe('30 s')
    expect(duration(12.4)).toBe('12 min')
    expect(duration(90)).toBe('1.5 h')
  })
})
