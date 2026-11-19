// The picture behind Today's greeting, on this device: in Edit Today and Settings → Appearance
// (docs/PLAN-today-sky.md R1). It applies at once.

import { SKY_SCENES, type SkyScene, useSkyScene, writeSkyScene } from './skyState'

/** A small dropdown for the Edit Today bar. */
export function SkyScenePicker() {
  const scene = useSkyScene()
  return (
    <label className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-ash-strong px-2 text-sm text-ink hover:border-ember">
      <span className="hidden sm:inline text-ink-soft">Sky</span>
      <select
        value={scene}
        onChange={(e) => writeSkyScene(e.target.value as SkyScene)}
        aria-label="Today’s sky"
        data-testid="today-sky-picker"
        className="bg-transparent py-1 pr-1 text-sm focus:outline-none"
      >
        {SKY_SCENES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/** Settings → Appearance: the same choice with a line about each. */
export function SkySceneSettings() {
  const scene = useSkyScene()
  return (
    <fieldset className="mt-10" data-testid="settings-today-sky">
      <legend className="font-display text-lg font-semibold text-ink">Today’s sky</legend>
      <p className="mt-1 text-sm text-ink-soft">
        The picture behind your greeting on Today. It uses the colours of your theme and the place
        you chose for weather. Just this device.
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {SKY_SCENES.map((s) => (
          <label
            key={s.value}
            className={`flex cursor-pointer flex-col rounded-lg border px-3 py-2 text-sm ${
              scene === s.value
                ? 'border-ember bg-paper-raised'
                : 'border-ash hover:border-ash-strong'
            }`}
          >
            <span className="flex items-center gap-2 font-medium text-ink">
              <input
                type="radio"
                name="today-sky"
                value={s.value}
                checked={scene === s.value}
                onChange={() => writeSkyScene(s.value)}
                data-testid={`settings-today-sky-${s.value}`}
              />
              {s.label}
            </span>
            <span className="mt-0.5 text-xs text-ink-soft">{s.detail}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}
