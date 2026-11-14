import { useEffect, useId, useState } from 'react'
import { HearthApiError } from '../api/client'
import { todayApi, type WeatherPlace } from '../api/today'

/** Type a city, pick one of the matches (Settings → Weather, the header, the team default). */
export function PlaceSearch({
  onPick,
  label = 'City',
  autoFocus = false,
  testId = 'place-search',
}: {
  onPick: (place: WeatherPlace) => void
  label?: string
  autoFocus?: boolean
  testId?: string
}) {
  const id = useId()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<WeatherPlace[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setResults(null)
      setError(null)
      return
    }
    let cancelled = false
    // Searches as you type, once you pause.
    const timer = setTimeout(() => {
      todayApi.places(q).then(
        (r) => {
          if (cancelled) return
          setResults(r.places)
          setError(null)
        },
        (err) => {
          if (cancelled) return
          setResults(null)
          setError(err instanceof HearthApiError ? err.message : 'Couldn’t search places')
        },
      )
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      <input
        id={id}
        type="search"
        value={query}
        // biome-ignore lint/a11y/noAutofocus: opened on purpose to type a city
        autoFocus={autoFocus}
        autoComplete="off"
        placeholder="Start typing a city, like Burlington"
        onChange={(e) => setQuery(e.target.value)}
        data-testid={`${testId}-input`}
        className="w-full rounded-lg border border-ash bg-paper-raised px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-ember focus:outline-none"
      />
      {error ? (
        <p role="alert" className="text-sm text-ember-strong">
          {error}
        </p>
      ) : results && results.length === 0 ? (
        <p className="text-sm text-ink-faint">No places by that name.</p>
      ) : results ? (
        <ul className="flex flex-col gap-1" aria-label="Matching places">
          {results.map((place) => (
            <li key={`${place.lat},${place.lon},${place.name}`}>
              <button
                type="button"
                onClick={() => onPick(place)}
                data-testid={`${testId}-result`}
                className="flex w-full items-baseline gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-ember-wash focus-visible:bg-ember-wash"
              >
                <span className="font-medium text-ink">{place.name}</span>
                {place.detail ? <span className="text-ink-faint">{place.detail}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
