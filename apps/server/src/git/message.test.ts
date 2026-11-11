import { describe, expect, it } from 'vitest'
import { formatCommitMessage, parseCommitMessage, withLabel, withVia } from './message.js'

describe('formatCommitMessage', () => {
  it('follows `<app>: <verb> "<title>"`', () => {
    expect(formatCommitMessage({ app: 'docs', verb: 'edit', title: 'Q4 plan' })).toBe(
      'docs: edit "Q4 plan"',
    )
  })

  it('adds a Hearth-Label trailer for named versions, on one line', () => {
    expect(
      formatCommitMessage({ app: 'docs', verb: 'edit', title: 'Q4 plan', label: 'Sent to\nboard' }),
    ).toBe('docs: edit "Q4 plan"\n\nHearth-Label: Sent to board')
  })

  it('ignores a blank label', () => {
    expect(formatCommitMessage({ app: 'docs', verb: 'edit', title: 'x', label: '  ' })).toBe(
      'docs: edit "x"',
    )
  })
})

describe('parseCommitMessage', () => {
  it('round-trips a labelled message', () => {
    const raw = `${formatCommitMessage({ app: 'docs', verb: 'edit', title: 'Q4', label: 'v1' })}\n`
    expect(parseCommitMessage(raw)).toEqual({ message: 'docs: edit "Q4"', label: 'v1' })
  })

  it('returns messages without a label unchanged (minus trailing whitespace)', () => {
    expect(parseCommitMessage('docs: edit "Q4"\n')).toEqual({ message: 'docs: edit "Q4"' })
    expect(parseCommitMessage('fix typo\n\nlonger body\n')).toEqual({
      message: 'fix typo\n\nlonger body',
    })
  })

  it('never reads the subject line as a trailer', () => {
    expect(parseCommitMessage('Hearth-Label: not a trailer')).toEqual({
      message: 'Hearth-Label: not a trailer',
    })
  })

  it('keeps other trailers in the message', () => {
    expect(
      parseCommitMessage('docs: edit "Q4"\n\nCo-Authored-By: A <a@x>\nHearth-Label: final\n'),
    ).toEqual({ message: 'docs: edit "Q4"\n\nCo-Authored-By: A <a@x>', label: 'final' })
  })
})

describe('withLabel', () => {
  it('appends the trailer to any message, and nothing for a blank label', () => {
    expect(withLabel('Weekly notes', 'Sent')).toBe('Weekly notes\n\nHearth-Label: Sent')
    expect(withLabel('Weekly notes', ' ')).toBe('Weekly notes')
    expect(withLabel('Weekly notes')).toBe('Weekly notes')
  })
})

describe('withVia', () => {
  it('adds a Hearth-Via trailer, joining the label’s paragraph when there is one', () => {
    expect(withVia('docs: edit "Q4"', 'mcp')).toBe('docs: edit "Q4"\n\nHearth-Via: mcp')
    expect(withVia('docs: edit "Q4"\n\nHearth-Label: final', 'mcp')).toBe(
      'docs: edit "Q4"\n\nHearth-Label: final\nHearth-Via: mcp',
    )
    expect(withVia('docs: edit "Q4"', '  ')).toBe('docs: edit "Q4"')
    expect(withVia('docs: edit "Q4"')).toBe('docs: edit "Q4"')
  })

  it('stays out of the label when the message is parsed back', () => {
    const message = withVia(withLabel('docs: edit "Q4"', 'final'), 'mcp (token "x")')
    expect(parseCommitMessage(message)).toEqual({
      message: 'docs: edit "Q4"\n\nHearth-Via: mcp (token "x")',
      label: 'final',
    })
  })
})
