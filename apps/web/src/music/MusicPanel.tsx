// The music controls (docs/PLAN-background-music.md): play or pause, the track and the volume.
// Shown in a small panel beside the rail's music button, and in the Apps sheet on phones.

import { Icon } from '../components/Icon'
import { music } from './player'
import { TRACKS } from './tracks'
import { useMusic } from './useMusic'

export const MUSIC_HELP = 'https://hotsauce.work/help/music'

/** What the player is doing, in a few words. */
export function musicStatus(s: ReturnType<typeof useMusic>): string {
  if (!s.on) return 'Off'
  if (s.held) return 'Paused while recording'
  if (s.failed) return 'Couldn’t load the music'
  if (s.waiting) return 'Starts when you click'
  return s.playing ? 'Playing' : 'Starting…'
}

export function MusicPanel({ autoFocus = false }: { autoFocus?: boolean }) {
  const s = useMusic()
  const player = music()
  return (
    <div className="flex w-60 flex-col gap-3" data-testid="music-panel">
      <div className="flex items-center gap-3">
        <button
          type="button"
          // biome-ignore lint/a11y/noAutofocus: the panel opens to its main control
          autoFocus={autoFocus}
          onClick={() => player.toggle()}
          data-testid="music-toggle"
          className="grid size-9 shrink-0 place-items-center rounded-full bg-ember text-paper-raised hover:bg-ember-strong"
        >
          <Icon name={s.on ? 'pause' : 'play'} className="size-4" />
          <span className="sr-only">{s.on ? 'Pause music' : 'Play music'}</span>
        </button>
        <span className="min-w-0">
          <span className="block text-sm font-medium text-ink">Background music</span>
          <span className="block text-xs text-ink-soft" data-testid="music-status">
            {musicStatus(s)}
          </span>
        </span>
      </div>
      <fieldset className="flex flex-col gap-0.5">
        <legend className="sr-only">Track</legend>
        {TRACKS.map((t) => (
          <label
            key={t.id}
            className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm text-ink hover:bg-paper-sunk"
          >
            <input
              type="radio"
              name="music-track"
              value={t.id}
              checked={s.track === t.id}
              onChange={() => player.setTrack(t.id)}
              data-testid={`music-track-${t.id}`}
              className="accent-ember"
            />
            {t.label}
          </label>
        ))}
      </fieldset>
      {s.fixedVolume ? (
        <p className="text-xs text-ink-soft" data-testid="music-volume-device">
          Set the volume with your device’s buttons.
        </p>
      ) : (
        <label className="flex items-center gap-2 text-xs text-ink-soft">
          <span className="shrink-0">Volume</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(s.volume * 100)}
            onChange={(e) => player.setVolume(Number(e.currentTarget.value) / 100)}
            aria-label="Music volume"
            data-testid="music-volume"
            className="min-w-0 flex-1 accent-ember"
          />
        </label>
      )}
      <p className="text-xs text-ink-faint">
        Only you hear it. It pauses while you record.{' '}
        <a
          href={MUSIC_HELP}
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-ash-strong underline-offset-2 hover:text-ink"
        >
          Music credits
        </a>
      </p>
    </div>
  )
}
