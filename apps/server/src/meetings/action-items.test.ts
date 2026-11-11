import { describe, expect, it } from 'vitest'
import { openActionItems } from './action-items.js'

describe('openActionItems', () => {
  it('finds unticked items with their file line, nested or not, in any bullet style', () => {
    const note = [
      '---',
      'type: meeting',
      '---',
      '# Sync',
      '',
      '## Action items',
      '- [ ] Alice: send the deck (Friday)',
      '* [ ] Bob: book the room',
      '    + [ ] nested follow-up',
      '- [x] done already',
      '- [X] also done',
      '- not a task',
      '-[ ] no space after the bullet',
    ].join('\n')
    expect(openActionItems(note)).toEqual([
      { line: 7, text: 'Alice: send the deck (Friday)' },
      { line: 8, text: 'Bob: book the room' },
      { line: 9, text: 'nested follow-up' },
    ])
  })

  it('skips fenced code, and counts CRLF lines the same', () => {
    const note = [
      '```md',
      '- [ ] in a fence',
      '```',
      '~~~',
      '- [ ] tilde fence',
      '~~~',
      '- [ ] real',
    ].join('\r\n')
    expect(openActionItems(note)).toEqual([{ line: 7, text: 'real' }])
  })

  it('ignores an empty item', () => {
    expect(openActionItems('- [ ] \n- [ ]')).toEqual([])
  })
})
