// Playback speed, remembered per person on this browser.

export const SPEEDS = [0.5, 1, 1.2, 1.5, 1.75, 2, 2.5] as const
const KEY = 'hearth.clips.speed'

export function loadSpeed(): number {
  try {
    const value = Number(localStorage.getItem(KEY))
    return (SPEEDS as readonly number[]).includes(value) ? value : 1
  } catch {
    return 1
  }
}

export function saveSpeed(speed: number): void {
  try {
    localStorage.setItem(KEY, String(speed))
  } catch {
    // Private windows and blocked storage: the speed just isn't remembered.
  }
}

/** The next speed up (`>`) or down (`<`), stopping at the ends. */
export function stepSpeed(current: number, direction: 1 | -1): number {
  const i = SPEEDS.indexOf(current as (typeof SPEEDS)[number])
  const next = (i === -1 ? 1 : i) + direction
  return SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, next))] as number
}

export function speedLabel(speed: number): string {
  return `${speed}×`
}
