// The Start screen's steps (ARCHITECTURE §7.5): choose a capture mode → the browser asks for
// permission → check that sound arrives on each track → start. Pure, so every path is tested
// without devices; the page performs the side effects each step calls for.

import type { Track } from '../../api/types'
import type { CaptureMode } from './audio/capture'

export type CheckState = 'waiting' | 'ok' | 'failed'
export type TrackChecks = Partial<Record<Track, CheckState>>

export type StartState =
  | { step: 'choose' }
  | { step: 'permission'; mode: CaptureMode }
  /** Permission refused, or a share without tab audio: nothing to check. */
  | { step: 'blocked'; mode: CaptureMode; message: string }
  | { step: 'check'; mode: CaptureMode; tracks: TrackChecks }
  | { step: 'starting'; mode: CaptureMode; tracks: TrackChecks }
  /** The session couldn't be created; the tracks are still captured. */
  | { step: 'error'; mode: CaptureMode; tracks: TrackChecks; message: string }

export type StartEvent =
  | { type: 'choose'; mode: CaptureMode }
  | { type: 'granted'; tracks: Track[] }
  | { type: 'refused'; message: string }
  | { type: 'checked'; track: Track; arrived: boolean }
  /** Listen again on the same tracks. */
  | { type: 'recheck' }
  | { type: 'start' }
  | { type: 'failed'; message: string }
  | { type: 'reset' }

export const INITIAL_START: StartState = { step: 'choose' }

/** All tracks heard: ok. Any still listening: waiting. Otherwise one stayed silent: failed. */
export function overallCheck(tracks: TrackChecks): CheckState {
  const states = Object.values(tracks)
  if (states.length === 0 || states.includes('waiting')) return 'waiting'
  return states.every((s) => s === 'ok') ? 'ok' : 'failed'
}

/** Start is offered once every track has an answer; a silent track means "Start anyway". */
export function canStart(state: StartState): boolean {
  if (state.step === 'error') return true
  return state.step === 'check' && overallCheck(state.tracks) !== 'waiting'
}

export function startReducer(state: StartState, event: StartEvent): StartState {
  switch (event.type) {
    case 'choose':
      return state.step === 'starting' ? state : { step: 'permission', mode: event.mode }
    case 'granted':
      if (state.step !== 'permission') return state
      return {
        step: 'check',
        mode: state.mode,
        tracks: Object.fromEntries(event.tracks.map((t) => [t, 'waiting' as const])),
      }
    case 'refused':
      return state.step === 'permission'
        ? { step: 'blocked', mode: state.mode, message: event.message }
        : state
    case 'checked':
      if (state.step !== 'check' || state.tracks[event.track] === undefined) return state
      return {
        ...state,
        tracks: { ...state.tracks, [event.track]: event.arrived ? 'ok' : 'failed' },
      }
    case 'recheck':
      if (state.step !== 'check') return state
      return {
        ...state,
        tracks: Object.fromEntries(
          Object.entries(state.tracks).map(([t, s]) => [t, s === 'ok' ? 'ok' : 'waiting']),
        ),
      }
    case 'start':
      return canStart(state) && (state.step === 'check' || state.step === 'error')
        ? { step: 'starting', mode: state.mode, tracks: state.tracks }
        : state
    case 'failed':
      return state.step === 'starting'
        ? { step: 'error', mode: state.mode, tracks: state.tracks, message: event.message }
        : state
    case 'reset':
      return state.step === 'starting' ? state : INITIAL_START
  }
}
