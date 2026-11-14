import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { OrgWeatherSection, WeatherSettingsSection } from './WeatherSettings'
import { WEATHER_PLACE_KEY } from './weatherPlace'

// W4, W6: Settings → Weather (this device) and Settings → Organization → Weather (the team).

afterEach(() => localStorage.removeItem(WEATHER_PLACE_KEY))

async function pickCity(testId: string, typed: string) {
  await userEvent.type(await screen.findByTestId(`${testId}-input`), typed)
  const [first] = await screen.findAllByTestId(`${testId}-result`)
  await userEvent.click(first as HTMLElement)
}

describe('Settings → Weather', () => {
  it('picks a city for this device and can hide the weather', async () => {
    render(<WeatherSettingsSection />)
    expect(await screen.findByTestId('settings-weather-now')).toHaveTextContent('Off.')
    await userEvent.click(screen.getByTestId('settings-weather-pick'))
    await pickCity('settings-weather-city', 'Lond')
    expect(screen.getByTestId('settings-weather-now')).toHaveTextContent(
      'Showing weather for London, England, United Kingdom.',
    )
    expect(JSON.parse(localStorage.getItem(WEATHER_PLACE_KEY) ?? '')).toMatchObject({
      name: 'London',
      lat: 51.51,
    })
    await userEvent.click(screen.getByTestId('settings-weather-hide'))
    expect(screen.getByTestId('settings-weather-now')).toHaveTextContent('Hidden on this device.')
  })

  it('says so when a city has no matches', async () => {
    render(<WeatherSettingsSection />)
    await userEvent.click(await screen.findByTestId('settings-weather-pick'))
    await userEvent.type(await screen.findByTestId('settings-weather-city-input'), 'Zzyzx')
    expect(await screen.findByText('No places by that name.')).toBeInTheDocument()
  })
})

describe('Settings → Organization → Weather', () => {
  it('sets the team city, which a device without its own place then uses', async () => {
    render(<OrgWeatherSection />)
    expect(await screen.findByText(/No team city\./)).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('org-weather-pick'))
    await pickCity('org-weather-city', 'Oslo')
    expect(await screen.findByTestId('org-weather-now')).toHaveTextContent(
      'Team city: Oslo, Oslo, Norway',
    )
    render(<WeatherSettingsSection />)
    expect(await screen.findByText(/your team’s city/)).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('org-weather-clear'))
    expect(await screen.findByText(/No team city\./)).toBeInTheDocument()
  })
})
