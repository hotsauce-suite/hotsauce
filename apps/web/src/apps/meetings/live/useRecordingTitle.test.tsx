import { render, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { LiveSnapshot } from './liveState'
import { recordingTitle } from './liveState'
import { useRecordingTitle } from './useRecordingTitle'

const live = (patch: Partial<LiveSnapshot> = {}): LiveSnapshot => ({
  id: 'S1',
  title: 'Acme sync',
  startedAt: new Date().toISOString(),
  state: 'recording',
  link: 'live',
  capturing: true,
  lostTrack: null,
  error: null,
  ...patch,
})

function Probe({ snapshot }: { snapshot: LiveSnapshot | null }) {
  useRecordingTitle(snapshot)
  return null
}

describe('the recording tab title', () => {
  it('reads "● Recording · title", "Paused · title", or nothing', () => {
    expect(recordingTitle(live())).toBe('● Recording · Acme sync')
    expect(recordingTitle(live({ state: 'paused' }))).toBe('Paused · Acme sync')
    expect(recordingTitle(live({ state: 'saved' }))).toBeNull()
  })

  it('holds the title while pages set their own, and hands the last one back at the end', async () => {
    document.title = 'Hearth Meetings'
    const { rerender } = render(<Probe snapshot={live()} />)
    expect(document.title).toBe('● Recording · Acme sync')

    // A doc opened meanwhile titles the tab; the recording label wins it back.
    document.title = 'Q4 plan · Hearth Docs'
    await waitFor(() => expect(document.title).toBe('● Recording · Acme sync'))

    rerender(<Probe snapshot={live({ state: 'paused' })} />)
    expect(document.title).toBe('Paused · Acme sync')

    rerender(<Probe snapshot={null} />)
    expect(document.title).toBe('Q4 plan · Hearth Docs')
  })
})
