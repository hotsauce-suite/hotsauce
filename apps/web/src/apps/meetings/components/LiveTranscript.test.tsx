import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LiveTranscript } from './LiveTranscript'

const segments = [{ speaker: 'S1', text: 'Hello there.', start: 0, end: 1 }]

describe('the live transcript panel (docs/PLAN-ipad.md T1)', () => {
  it('floats over the page only as the live meeting’s side panel', () => {
    const { unmount } = render(
      <LiveTranscript segments={segments as never} expanded floating onToggle={() => {}} />,
    )
    expect(screen.getByTestId('live-transcript')).toHaveClass('side-pane')
    unmount()
    render(<LiveTranscript segments={segments as never} expanded onToggle={() => {}} />)
    expect(screen.getByTestId('live-transcript')).not.toHaveClass('side-pane')
  })
})
