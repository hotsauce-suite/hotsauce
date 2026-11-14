import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DatePicker } from './DatePicker'

function Harness({ initial = '', onChange }: { initial?: string; onChange?: (v: string) => void }) {
  const [value, setValue] = useState(initial)
  return (
    <DatePicker
      value={value}
      label="Due date"
      testId="pick"
      today="2026-11-13"
      onChange={(v) => {
        setValue(v)
        onChange?.(v)
      }}
    />
  )
}

const open = async () => {
  await userEvent.click(screen.getByTestId('pick'))
  return screen.getByTestId('date-picker')
}

describe('DatePicker (W2)', () => {
  it('shows the month with Monday first and Sunday last', async () => {
    render(<Harness />)
    const cal = await open()
    const heads = within(cal)
      .getAllByRole('columnheader')
      .map((th) => th.getAttribute('abbr'))
    expect(heads).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
    // November 2026 starts on a Sunday, so the first row runs Oct 26 to Nov 1.
    const first = within(cal).getAllByRole('row')[1] as HTMLElement
    const dates = within(first)
      .getAllByRole('button')
      .map((b) => b.dataset.date)
    expect(dates).toEqual([
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
    ])
    expect(cal.querySelector('[data-date="2026-11-13"]')).toHaveAttribute('aria-current', 'date')
  })

  it('reports the picked day as YYYY-MM-DD and shows it on the button', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    const cal = await open()
    await userEvent.click(cal.querySelector('[data-date="2026-11-20"]') as HTMLElement)
    expect(onChange).toHaveBeenCalledWith('2026-11-20')
    expect(screen.queryByTestId('date-picker')).toBeNull()
    expect(screen.getByTestId('pick')).toHaveAttribute('data-value', '2026-11-20')
    expect(screen.getByTestId('pick')).toHaveTextContent(/Nov 20/)
  })

  it('moves between months, and has Today and Clear', async () => {
    const onChange = vi.fn()
    render(<Harness initial="2026-12-31" onChange={onChange} />)
    let cal = await open()
    expect(within(cal).getByTestId('date-picker-month')).toHaveTextContent(/December 2026/)
    await userEvent.click(within(cal).getByTestId('date-picker-next'))
    expect(within(cal).getByTestId('date-picker-month')).toHaveTextContent(/January 2027/)
    await userEvent.click(within(cal).getByTestId('date-picker-prev'))
    await userEvent.click(within(cal).getByTestId('date-picker-prev'))
    expect(within(cal).getByTestId('date-picker-month')).toHaveTextContent(/November 2026/)
    await userEvent.click(within(cal).getByTestId('date-picker-today'))
    expect(onChange).toHaveBeenLastCalledWith('2026-11-13')
    cal = await open()
    await userEvent.click(within(cal).getByTestId('date-picker-clear'))
    expect(onChange).toHaveBeenLastCalledWith('')
    expect(screen.getByTestId('pick')).toHaveTextContent('No date')
  })

  it('arrow keys move a day or a week, Enter picks, Escape closes', async () => {
    const onChange = vi.fn()
    render(<Harness initial="2026-11-30" onChange={onChange} />)
    await open()
    expect(document.activeElement).toHaveAttribute('data-date', '2026-11-30')
    await userEvent.keyboard('{ArrowRight}')
    expect(document.activeElement).toHaveAttribute('data-date', '2026-12-01')
    expect(screen.getByTestId('date-picker-month')).toHaveTextContent(/December 2026/)
    await userEvent.keyboard('{ArrowUp}{ArrowLeft}')
    expect(document.activeElement).toHaveAttribute('data-date', '2026-11-23')
    await userEvent.keyboard('{Enter}')
    expect(onChange).toHaveBeenLastCalledWith('2026-11-23')
    await open()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByTestId('date-picker')).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('pick'))
  })
})
