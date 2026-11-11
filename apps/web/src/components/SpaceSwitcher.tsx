import type { Space } from '../api/types'

export function SpaceSwitcher({
  spaces,
  current,
  onChange,
}: {
  spaces: Space[]
  current: string
  onChange: (space: string) => void
}) {
  return (
    <fieldset
      data-testid="space-switcher"
      aria-label="Space"
      className="mx-3 grid grid-flow-col gap-1 rounded-lg border border-ash bg-paper/60 p-1"
    >
      {spaces.map((space) => {
        const selected = space.name === current
        return (
          <button
            key={space.name}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(space.name)}
            className={`h-7 rounded-md text-sm transition-colors ${
              selected
                ? 'bg-paper-raised font-medium text-ink shadow-[0_1px_2px_rgb(70_34_12/0.12)]'
                : 'text-ink-soft hover:text-ink'
            }`}
          >
            {space.label}
          </button>
        )
      })}
    </fieldset>
  )
}
