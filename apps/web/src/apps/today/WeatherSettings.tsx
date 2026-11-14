// Settings → Weather (this device's place) and Settings → Organization → Weather (the team's
// default place). docs/PLAN-weather-place.md W4, W6.

import { useEffect, useState } from 'react'
import { todayApi, type WeatherPlace } from '../../api/today'
import { PlaceSearch } from '../../components/PlaceSearch'
import { askLocation, useDeviceWeather, writeDeviceWeather } from './weatherPlace'

const sectionTitle = 'font-display text-[1.6rem] font-semibold tracking-tight'
const button =
  'rounded-lg border border-ash-strong px-3 py-1.5 text-sm text-ink hover:bg-paper-sunk disabled:opacity-50'

function placeLabel(place: { name?: string | undefined; detail?: string | undefined }): string {
  return place.detail ? `${place.name}, ${place.detail}` : (place.name ?? '')
}

/** Settings → Weather: where Today's weather is for, on this device. */
export function WeatherSettingsSection() {
  const device = useDeviceWeather()
  const [team, setTeam] = useState<WeatherPlace | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [searching, setSearching] = useState(false)
  useEffect(() => {
    todayApi.defaultPlace().then(
      (r) => setTeam(r.place),
      () => setTeam(null),
    )
  }, [])

  const now =
    device.kind === 'off'
      ? 'Hidden on this device.'
      : device.kind === 'place'
        ? device.place.name
          ? `Showing weather for ${placeLabel(device.place)}.`
          : 'Showing weather for your location.'
        : team
          ? `Showing weather for ${placeLabel(team)}, your team’s city.`
          : 'Off. Pick a city or share your location to show it on Today.'

  const shareLocation = async () => {
    setBusy(true)
    setMessage(null)
    const result = await askLocation()
    setBusy(false)
    if (result.kind === 'place') writeDeviceWeather({ kind: 'place', place: result.place })
    else if (result.kind === 'denied')
      setMessage(
        'Location is turned off for this app or site. Allow it in your browser’s site settings (or System Settings on a Mac), or pick a city instead.',
      )
    else if (result.kind === 'oldMacApp')
      setMessage(
        'This version of the Mac app can’t share your location. Update it, or pick a city.',
      )
    else setMessage(result.message)
  }

  return (
    <section aria-labelledby="weather-title" data-testid="settings-weather" className="mt-12">
      <h2 id="weather-title" className={sectionTitle}>
        Weather
      </h2>
      <p className="mt-2 text-ink-soft">
        The weather at the top of Today. Your choice is kept on this device only; the server sees
        just the place, rounded to about a kilometre.
      </p>
      <p className="mt-3 text-sm text-ink" data-testid="settings-weather-now">
        {now}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className={button}
          disabled={busy}
          onClick={() => void shareLocation()}
          data-testid="settings-weather-location"
        >
          Use my location
        </button>
        <button
          type="button"
          className={button}
          onClick={() => setSearching((s) => !s)}
          data-testid="settings-weather-pick"
        >
          Use a city
        </button>
        {device.kind !== 'off' ? (
          <button
            type="button"
            className={button}
            onClick={() => writeDeviceWeather({ kind: 'off' })}
            data-testid="settings-weather-hide"
          >
            Hide weather
          </button>
        ) : null}
        {device.kind !== 'unset' && team ? (
          <button
            type="button"
            className={button}
            onClick={() => writeDeviceWeather({ kind: 'unset' })}
            data-testid="settings-weather-team"
          >
            Use the team’s city
          </button>
        ) : null}
      </div>
      {message ? (
        <p role="alert" className="mt-3 text-sm text-ember-strong">
          {message}
        </p>
      ) : null}
      {searching ? (
        <div className="mt-4 max-w-md">
          <PlaceSearch
            autoFocus
            testId="settings-weather-city"
            onPick={(place) => {
              setSearching(false)
              setMessage(null)
              writeDeviceWeather({ kind: 'place', place })
            }}
          />
        </div>
      ) : null}
    </section>
  )
}

/** Settings → Organization → Weather: the city everyone sees until they pick their own. */
export function OrgWeatherSection() {
  const [place, setPlace] = useState<WeatherPlace | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  useEffect(() => {
    todayApi.defaultPlace().then(
      (r) => setPlace(r.place),
      () => setPlace(null),
    )
  }, [])
  const save = async (next: WeatherPlace | null) => {
    setBusy(true)
    setError(null)
    try {
      setPlace((await todayApi.setDefaultPlace(next)).place)
      setSearching(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section data-testid="org-weather" className="flex flex-col gap-4">
      <div>
        <h2 className="font-display text-[1.6rem] leading-tight font-semibold tracking-tight text-ink">
          Weather
        </h2>
        <p className="mt-2 text-ink-soft">
          Today shows the weather for this city to everyone who hasn’t shared their location or
          picked a city of their own. Leave it empty to keep weather off until each person turns it
          on.
        </p>
      </div>
      <p className="text-sm text-ink" data-testid="org-weather-now">
        {place === undefined
          ? null
          : place
            ? `Team city: ${placeLabel(place)}`
            : 'No team city. Weather is off until each person turns it on.'}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={button}
          disabled={busy || place === undefined}
          onClick={() => setSearching((s) => !s)}
          data-testid="org-weather-pick"
        >
          {place ? 'Change city' : 'Set a city'}
        </button>
        {place ? (
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() => void save(null)}
            data-testid="org-weather-clear"
          >
            Remove
          </button>
        ) : null}
      </div>
      {searching ? (
        <div className="max-w-md">
          <PlaceSearch autoFocus testId="org-weather-city" onPick={(p) => void save(p)} />
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-ember-strong">
          {error}
        </p>
      ) : null}
    </section>
  )
}
