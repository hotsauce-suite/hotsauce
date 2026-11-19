import { writeSwitchFx } from '../lib/switchFx'
import { useSwitchFxPrefs } from './useSwitchFx'

// Settings → Appearance: the ripple (and optional sound) when switching tools
// (docs/PLAN-switch-ripple.md R6).

function Switch({
  title,
  detail,
  checked,
  testId,
  onChange,
}: {
  title: string
  detail: string
  checked: boolean
  testId: string
  onChange: (on: boolean) => void
}) {
  return (
    <label className="flex items-center gap-3 rounded-xl border border-ash bg-paper-raised/60 p-4">
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-ink">{title}</span>
        <span className="block text-sm text-ink-soft">{detail}</span>
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        data-testid={testId}
        checked={checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
        className="size-5 accent-ember"
      />
    </label>
  )
}

export function SwitchFxSettings() {
  const prefs = useSwitchFxPrefs()
  return (
    <div data-testid="switch-fx-settings" className="mt-6 grid gap-2">
      <Switch
        title="Ripple when switching tools"
        detail="A soft ripple spreads from your click when you open another tool. Skipped when your device is set to reduce motion."
        checked={prefs.ripple}
        testId="switch-fx-ripple"
        onChange={(ripple) => writeSwitchFx({ ripple })}
      />
      <Switch
        title="Play a soft sound when switching tools"
        detail="A quiet tick. Stays silent while anything is recording."
        checked={prefs.sound}
        testId="switch-fx-sound"
        onChange={(sound) => writeSwitchFx({ sound })}
      />
    </div>
  )
}
