import { describe, expect, it } from 'vitest'
import { formatCommitMessage, parseCommitMessage, viaLabel, withLabel, withVia } from './message.js'

describe('formatCommitMessage', () => {
  it('follows `<app>: <verb> "<title>"`', () => {
    expect(formatCommitMessage({ app: 'docs', verb: 'edit', title: 'Q4 plan' })).toBe(
      'docs: edit "Q4 plan"',
    )
  })

  it('adds a Hotsauce-Label trailer for named versions, on one line', () => {
    expect(
      formatCommitMessage({ app: 'docs', verb: 'edit', title: 'Q4 plan', label: 'Sent to\nboard' }),
    ).toBe('docs: edit "Q4 plan"\n\nHotsauce-Label: Sent to board')
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

  it('reads the Hearth-Label trailer older commits carry', () => {
    expect(parseCommitMessage('docs: edit "Q4"\n\nHearth-Label: v1\n')).toEqual({
      message: 'docs: edit "Q4"',
      label: 'v1',
    })
  })

  it('returns messages without a label unchanged (minus trailing whitespace)', () => {
    expect(parseCommitMessage('docs: edit "Q4"\n')).toEqual({ message: 'docs: edit "Q4"' })
    expect(parseCommitMessage('fix typo\n\nlonger body\n')).toEqual({
      message: 'fix typo\n\nlonger body',
    })
  })

  it('never reads the subject line as a trailer', () => {
    expect(parseCommitMessage('Hotsauce-Label: not a trailer')).toEqual({
      message: 'Hotsauce-Label: not a trailer',
    })
  })

  it('keeps other trailers in the message', () => {
    expect(
      parseCommitMessage('docs: edit "Q4"\n\nCo-Authored-By: A <a@x>\nHotsauce-Label: final\n'),
    ).toEqual({ message: 'docs: edit "Q4"\n\nCo-Authored-By: A <a@x>', label: 'final' })
  })
})

describe('withLabel', () => {
  it('appends the trailer to any message, and nothing for a blank label', () => {
    expect(withLabel('Weekly notes', 'Sent')).toBe('Weekly notes\n\nHotsauce-Label: Sent')
    expect(withLabel('Weekly notes', ' ')).toBe('Weekly notes')
    expect(withLabel('Weekly notes')).toBe('Weekly notes')
  })
})

describe('withVia', () => {
  it('adds a Hotsauce-Via trailer, joining the label’s paragraph when there is one', () => {
    expect(withVia('docs: edit "Q4"', 'mcp')).toBe('docs: edit "Q4"\n\nHotsauce-Via: mcp')
    expect(withVia('docs: edit "Q4"\n\nHotsauce-Label: final', 'mcp')).toBe(
      'docs: edit "Q4"\n\nHotsauce-Label: final\nHotsauce-Via: mcp',
    )
    expect(withVia('docs: edit "Q4"', '  ')).toBe('docs: edit "Q4"')
    expect(withVia('docs: edit "Q4"')).toBe('docs: edit "Q4"')
  })

  it('stays out of the label when the message is parsed back', () => {
    const message = withVia(withLabel('docs: edit "Q4"', 'final'), 'mcp (token "x")')
    expect(parseCommitMessage(message)).toEqual({
      message: 'docs: edit "Q4"\n\nHotsauce-Via: mcp (token "x")',
      label: 'final',
    })
  })
})

describe('viaLabel', () => {
  it('names the AI tool from a new trailer', () => {
    expect(
      viaLabel('docs: edit "Q4"\n\nHotsauce-Via: mcp (client "Cursor", token "My laptop")'),
    ).toBe('Cursor')
    expect(
      viaLabel('docs: edit "Q4"\n\nHotsauce-Label: v1\nHotsauce-Via: mcp (client "Codex")'),
    ).toBe('Codex')
  })

  it('still reads the Hearth-Via trailer older commits carry', () => {
    expect(viaLabel('docs: edit "Q4"\n\nHearth-Via: mcp (client "Cursor", token "x")')).toBe(
      'Cursor',
    )
    expect(viaLabel('docs: edit "Q4"\n\nHearth-Label: v1\nHearth-Via: mcp (token "Laptop")')).toBe(
      'Laptop',
    )
  })

  it('falls back to the token name for older trailers', () => {
    expect(viaLabel('docs: edit "Q4"\n\nHotsauce-Via: mcp (token "Claude Code")')).toBe(
      'Claude Code',
    )
    expect(viaLabel('docs: edit "Q4"\n\nHotsauce-Via: api (token "script")')).toBe('script')
    expect(viaLabel('docs: edit "Q4"\n\nHotsauce-Via: mcp')).toBe('an AI tool')
  })

  it('reads the client only where the server writes it, first in the parentheses', () => {
    expect(viaLabel('docs: edit\n\nHotsauce-Via: api (token "x", client "Claude Code")')).toBe('x')
  })

  it('has none without an agent trailer', () => {
    expect(viaLabel('docs: edit "Q4"')).toBeUndefined()
    expect(viaLabel('Hotsauce-Via: mcp')).toBeUndefined()
    expect(viaLabel('forms: add "x"\n\nHotsauce-Via: forms (public link)')).toBeUndefined()
    expect(viaLabel('assistant: undo\n\nHotsauce-Via: assistant')).toBeUndefined()
  })
})
