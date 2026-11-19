import type { BreakAnimation } from '@hotsauce/format'

// The calming animations for a screen break (docs/PLAN-breaks.md B7), also shown small as a
// preview in Settings. A device set to reduce motion sees them still (breaks.css).

export const ANIMATION_LABELS: Record<BreakAnimation, string> = {
  breathe: 'Breathing circle',
  clouds: 'Drifting clouds',
  waves: 'Slow waves',
}

const CLOUDS = [
  { top: '18%', width: '46%', height: '16%', duration: 38, delay: -6 },
  { top: '44%', width: '34%', height: '12%', duration: 52, delay: -30 },
  { top: '64%', width: '54%', height: '18%', duration: 44, delay: -18 },
]

const WAVES = [
  { bottom: '30%', fill: 'rgb(255 255 255 / 0.10)', duration: 18 },
  { bottom: '16%', fill: 'rgb(255 255 255 / 0.16)', duration: 13 },
  { bottom: '0%', fill: 'rgb(255 255 255 / 0.24)', duration: 9 },
]

/** One wave's shape, repeated twice across 200% width so it can slide seamlessly. */
const WAVE_PATH = 'M0 30 Q 50 10 100 30 T 200 30 T 300 30 T 400 30 V 60 H 0 Z'

export function BreakScene({
  animation,
  className = '',
  testId,
}: {
  animation: BreakAnimation
  className?: string
  testId?: string
}) {
  if (animation === 'clouds') {
    return (
      <div
        aria-hidden="true"
        data-testid={testId}
        data-animation="clouds"
        className={`break-scene break-sky ${className}`}
      >
        {CLOUDS.map((c) => (
          <span
            key={c.top}
            className="break-cloud"
            style={{
              top: c.top,
              width: c.width,
              height: c.height,
              animationDuration: `${c.duration}s`,
              animationDelay: `${c.delay}s`,
            }}
          />
        ))}
      </div>
    )
  }
  if (animation === 'waves') {
    return (
      <div
        aria-hidden="true"
        data-testid={testId}
        data-animation="waves"
        className={`break-scene break-sea ${className}`}
      >
        {WAVES.map((w) => (
          <svg
            key={w.bottom}
            aria-hidden="true"
            className="break-wave"
            style={{ bottom: w.bottom, height: '40%', animationDuration: `${w.duration}s` }}
            viewBox="0 0 400 60"
            preserveAspectRatio="none"
          >
            <path d={WAVE_PATH} fill={w.fill} />
          </svg>
        ))}
      </div>
    )
  }
  return (
    <div
      aria-hidden="true"
      data-testid={testId}
      data-animation="breathe"
      className={`flex items-center justify-center ${className}`}
    >
      <span
        className="break-breathe block size-full rounded-full"
        style={{ ['--break-glow' as string]: 'var(--ember)' }}
      />
    </div>
  )
}
