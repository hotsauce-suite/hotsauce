import { describe, expect, it } from 'vitest'
import {
  canStart,
  INITIAL_START,
  overallCheck,
  type StartEvent,
  type StartState,
  startReducer,
} from './startMachine'

const run = (events: StartEvent[], from: StartState = INITIAL_START) =>
  events.reduce(startReducer, from)

describe('Start screen state machine', () => {
  it('mic only: choose → permission → check → ok → starting', () => {
    let state = run([{ type: 'choose', mode: 'mic-only' }])
    expect(state).toEqual({ step: 'permission', mode: 'mic-only' })
    state = run([{ type: 'granted', tracks: ['me'] }], state)
    expect(state).toEqual({ step: 'check', mode: 'mic-only', tracks: { me: 'waiting' } })
    expect(canStart(state)).toBe(false)
    state = run([{ type: 'checked', track: 'me', arrived: true }], state)
    expect(state.step === 'check' && overallCheck(state.tracks)).toBe('ok')
    expect(canStart(state)).toBe(true)
    state = run([{ type: 'start' }], state)
    expect(state).toEqual({ step: 'starting', mode: 'mic-only', tracks: { me: 'ok' } })
  })

  it('Meet tab: waits for both tracks; one silent track fails the check but can start anyway', () => {
    const state = run([
      { type: 'choose', mode: 'meet-tab' },
      { type: 'granted', tracks: ['them', 'me'] },
      { type: 'checked', track: 'me', arrived: true },
    ])
    expect(state.step === 'check' && overallCheck(state.tracks)).toBe('waiting')
    const silent = run([{ type: 'checked', track: 'them', arrived: false }], state)
    expect(silent.step === 'check' && overallCheck(silent.tracks)).toBe('failed')
    expect(canStart(silent)).toBe(true)
    // Check again re-listens to the silent track only.
    const again = run([{ type: 'recheck' }], silent)
    expect(again).toMatchObject({ step: 'check', tracks: { me: 'ok', them: 'waiting' } })
    expect(canStart(again)).toBe(false)
  })

  it('a refused permission blocks until the person chooses again', () => {
    const blocked = run([
      { type: 'choose', mode: 'meet-tab' },
      { type: 'refused', message: 'Tick “Share tab audio”.' },
    ])
    expect(blocked).toEqual({
      step: 'blocked',
      mode: 'meet-tab',
      message: 'Tick “Share tab audio”.',
    })
    expect(canStart(blocked)).toBe(false)
    expect(run([{ type: 'start' }], blocked)).toBe(blocked)
    expect(run([{ type: 'choose', mode: 'mic-only' }], blocked)).toEqual({
      step: 'permission',
      mode: 'mic-only',
    })
  })

  it('a failed start keeps the tracks and can be retried', () => {
    const error = run([
      { type: 'choose', mode: 'mic-only' },
      { type: 'granted', tracks: ['me'] },
      { type: 'checked', track: 'me', arrived: true },
      { type: 'start' },
      { type: 'failed', message: 'Could not reach the Hearth server' },
    ])
    expect(error).toEqual({
      step: 'error',
      mode: 'mic-only',
      tracks: { me: 'ok' },
      message: 'Could not reach the Hearth server',
    })
    expect(run([{ type: 'start' }], error).step).toBe('starting')
  })

  it('ignores events that do not fit the step', () => {
    const starting = run([
      { type: 'choose', mode: 'mic-only' },
      { type: 'granted', tracks: ['me'] },
      { type: 'checked', track: 'me', arrived: true },
      { type: 'start' },
    ])
    // Nothing interrupts a start in flight.
    expect(run([{ type: 'choose', mode: 'meet-tab' }], starting)).toBe(starting)
    expect(run([{ type: 'reset' }], starting)).toBe(starting)
    // A late answer for a track that isn't being checked changes nothing.
    const check = run([
      { type: 'choose', mode: 'mic-only' },
      { type: 'granted', tracks: ['me'] },
    ])
    expect(run([{ type: 'checked', track: 'them', arrived: true }], check)).toBe(check)
    expect(run([{ type: 'granted', tracks: ['me'] }], INITIAL_START)).toBe(INITIAL_START)
  })
})
