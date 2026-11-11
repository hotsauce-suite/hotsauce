import { describe, expect, it } from 'vitest'
import { aiRangesFor } from '../../mocks/fakeMeetings'
import {
  attendeeName,
  dayKey,
  dayLabel,
  formatClock,
  isTranscriptPath,
  meetingLabel,
} from './format'

describe('Meetings display helpers', () => {
  it('labels days relative to today', () => {
    const now = new Date(2026, 9, 8, 15, 0)
    expect(dayLabel(new Date(2026, 9, 8, 0, 5), now)).toBe('Today')
    expect(dayLabel(new Date(2026, 9, 7, 23, 59), now)).toBe('Yesterday')
    expect(dayLabel(new Date(2026, 9, 9, 9, 0), now)).toBe('Tomorrow')
    expect(dayLabel(new Date(2026, 9, 5, 9, 0), now)).not.toMatch(/Today|Yesterday|2026/)
    expect(dayLabel(new Date(2025, 9, 5, 9, 0), now)).toMatch(/2025/)
    expect(dayKey(new Date(2026, 9, 8, 23, 59))).toBe('2026-10-08')
  })

  it('formats elapsed time as m:ss, then h:mm:ss', () => {
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(65_400)).toBe('1:05')
    expect(formatClock(3_725_000)).toBe('1:02:05')
    expect(formatClock(-5)).toBe('0:00')
  })

  it('reads attendee names and meeting titles out of what the files hold', () => {
    expect(attendeeName('Dana Lee <dana@acme.com>')).toBe('Dana Lee')
    expect(attendeeName('dana@acme.com')).toBe('dana')
    expect(meetingLabel('meetings/2026/10/2026-10-07-acme-sync.transcript.md')).toBe('Acme sync')
    expect(meetingLabel('meetings/2026/10/2026-10-07-acme-sync.md')).toBe('Acme sync')
    expect(isTranscriptPath('meetings/a.transcript.md')).toBe(true)
    expect(isTranscriptPath('meetings/a.md')).toBe(false)
  })
})

describe('the mock’s ai_ranges (mirrors assembleEnhancedNote)', () => {
  it('marks every line that isn’t one of the member’s own as AI, in body line numbers', () => {
    const body = '# Title\n## Notes\nmy line\n- AI line\n\nsecond line\n- [ ] AI action\n'
    expect(aiRangesFor(body, '  my line  \r\nsecond line\r\n')).toEqual([
      [1, 2],
      [4, 5],
      [7, 7],
    ])
  })

  it('makes everything AI when there were no raw notes', () => {
    expect(aiRangesFor('# Title\n- a\n', '')).toEqual([[1, 2]])
  })
})
