import { describe, expect, it } from 'vitest'
import { renameInAiLines } from './speakers.js'

describe('renameInAiLines', () => {
  const body =
    '# T\r\n\r\n- Speaker 1 asked Speaker 2\r\n- my own Speaker 1 line\r\n- Speaker 12 too\r\n'

  it('renames whole labels on AI lines only, keeping CRLF', () => {
    expect(renameInAiLines(body, [[1, 3]], { 'Speaker 1': 'Priya' })).toBe(
      '# T\r\n\r\n- Priya asked Speaker 2\r\n- my own Speaker 1 line\r\n- Speaker 12 too\r\n',
    )
  })

  it('swaps in one pass, so neither label is renamed twice', () => {
    const out = renameInAiLines(body, [[1, 5]], {
      'Speaker 1': 'Speaker 2',
      'Speaker 2': 'Speaker 1',
    })
    expect(out).toContain('- Speaker 2 asked Speaker 1')
  })

  it('never looks labels up on the object prototype', () => {
    const text = '- constructor said hi\n'
    expect(renameInAiLines(text, [[1, 1]], { 'Speaker 1': 'x' })).toBe(text)
  })
})
