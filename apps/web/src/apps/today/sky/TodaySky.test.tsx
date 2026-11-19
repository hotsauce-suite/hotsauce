import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { server } from '../../../test/mockServer'
import { renderApp } from '../../../test/renderApp'
import { WEATHER_PLACE_KEY } from '../weatherPlace'
import { SKY_SCENE_KEY } from './skyState'
import { sunTimes } from './sunMoon'
import { moonPath, SkyBand, sunLine, weatherKind } from './TodaySky'

const MONTPELIER = { lat: 44.26, lon: -72.58 }

function band(now: Date, place: typeof MONTPELIER | null, symbol: string | null = null) {
  return render(
    <MemoryRouter>
      <SkyBand scene="sky" now={now} place={place} symbol={symbol}>
        <p>Good afternoon</p>
      </SkyBand>
    </MemoryRouter>,
  )
}

afterEach(() => {
  localStorage.removeItem(SKY_SCENE_KEY)
  localStorage.removeItem(WEATHER_PLACE_KEY)
})

describe('the sky band', () => {
  it('R2: by day the sun is up, high near midday, with sunrise and sunset under the greeting', () => {
    band(new Date('2026-11-19T16:40:00Z'), MONTPELIER)
    const sky = screen.getByTestId('today-sky')
    expect(sky).toHaveAttribute('data-phase', 'day')
    expect(screen.getByTestId('today-sun')).toBeInTheDocument()
    expect(screen.queryByTestId('today-moon')).toBeNull()
    expect(screen.getByText('Good afternoon')).toBeInTheDocument()
    expect(screen.getByTestId('today-sun-line')).toHaveTextContent(
      /Sunrise .* · Sunset .* · 9h \d+m of daylight/,
    )
  })

  it('R2: at night the moon shows in its phase, with tomorrow’s sunrise', () => {
    band(new Date('2026-11-22T04:00:00Z'), MONTPELIER)
    expect(screen.getByTestId('today-sky')).toHaveAttribute('data-phase', 'night')
    expect(screen.queryByTestId('today-sun')).toBeNull()
    expect(screen.getByTestId('today-moon')).toHaveAttribute('data-moon', 'Waxing gibbous')
  })

  it('R3: after sunset the line says when the sun comes back', () => {
    const now = new Date('2026-11-20T01:00:00Z')
    const today = sunTimes(new Date('2026-11-19T17:00:00Z'), MONTPELIER)
    const tomorrow = sunTimes(new Date('2026-11-20T17:00:00Z'), MONTPELIER)
    expect(sunLine(now, today, tomorrow)).toMatch(/^Sunset was .* · Sunrise tomorrow /)
  })

  it('R4: with no place it follows the clock and offers to set one', () => {
    band(new Date(2026, 10, 19, 12, 0), null)
    expect(screen.getByTestId('today-sky')).toHaveAttribute('data-phase', 'day')
    expect(screen.getByTestId('today-sky-set-place')).toHaveAttribute('href', '/settings')
  })

  it('R5: the weather shows lightly in the sky', () => {
    expect(weatherKind('lightrainshowers_day')).toMatchObject({ rain: true, clouds: 2 })
    expect(weatherKind('heavysnow')).toMatchObject({ snow: true, rain: false })
    expect(weatherKind('fog')).toMatchObject({ fog: true })
    expect(weatherKind('clearsky_night')).toMatchObject({ clouds: 0, rain: false })
    const { container } = band(new Date('2026-11-19T16:40:00Z'), MONTPELIER, 'rain')
    expect(container.querySelectorAll('.sky-drop').length).toBeGreaterThan(0)
    expect(container.querySelectorAll('.sky-cloud').length).toBe(2)
  })

  it('draws a thin crescent for a young moon and nearly the whole disc near full', () => {
    expect(moonPath(0.05)).toMatch(/A 1[4-7]\.\d+ 18 0 0 0/)
    expect(moonPath(0.45)).toMatch(/A 1[4-7]\.\d+ 18 0 0 1/)
  })
})

describe('on Today', () => {
  it('R1, R4: the sky sits behind the greeting, using the team’s place when the device has none', async () => {
    server.use(
      http.get('/api/today/default-place', () =>
        HttpResponse.json({
          place: { name: 'Montpelier', detail: 'Vermont, United States', lat: 44.26, lon: -72.58 },
        }),
      ),
    )
    renderApp('/today')
    const sky = await screen.findByTestId('today-sky')
    expect(within(sky).getByTestId('today-greeting')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId('today-sun-line')).toHaveTextContent(/Sun(rise|set)/),
    )
  })

  it('R1: Edit Today picks the scene, and Off leaves the greeting as before', async () => {
    renderApp('/today')
    await screen.findByTestId('today-sky')
    await userEvent.click(await screen.findByTestId('today-edit'))
    await userEvent.selectOptions(screen.getByTestId('today-sky-picker'), 'path')
    expect(screen.getByTestId('today-sky')).toHaveAttribute('data-scene', 'path')
    await userEvent.selectOptions(screen.getByTestId('today-sky-picker'), 'off')
    expect(screen.queryByTestId('today-sky')).toBeNull()
    expect(screen.getByTestId('today-greeting')).toBeInTheDocument()
    expect(localStorage.getItem(SKY_SCENE_KEY)).toBe('off')
  })

  it('R1: Settings → Appearance has the same choice', async () => {
    localStorage.setItem(SKY_SCENE_KEY, 'off')
    renderApp('/settings')
    const radio = await screen.findByTestId('settings-today-sky-sky')
    expect(screen.getByTestId('settings-today-sky-off')).toBeChecked()
    await userEvent.click(radio)
    expect(localStorage.getItem(SKY_SCENE_KEY)).toBeNull()
  })
})
