import { describe, expect, it } from 'vitest'
import { hearthTarget, toolLine } from './tools'

describe('hearthTarget', () => {
  it('reads a space and path, decoding what Markdown encoded', () => {
    expect(hearthTarget('hearth:team/docs/Launch%20plan.md')).toEqual({
      space: 'team',
      path: 'docs/Launch plan.md',
    })
    expect(hearthTarget('hearth:alice/tasks/01J.md')).toEqual({
      space: 'alice',
      path: 'tasks/01J.md',
    })
  })

  it('ignores anything else', () => {
    expect(hearthTarget('https://example.com')).toBeNull()
    expect(hearthTarget('hearth:team')).toBeNull()
    expect(hearthTarget('javascript:alert(1)')).toBeNull()
  })
})

describe('toolLine', () => {
  it('says what each tool did in plain words', () => {
    expect(toolLine({ name: 'search', input: { query: 'pricing' } })).toBe('Searched “pricing”')
    expect(toolLine({ name: 'read_file', input: { space: 'team', path: 'docs/a.md' } })).toBe(
      'Read team/docs/a.md',
    )
    expect(toolLine({ name: 'add_task', input: { text: 'Call Sam' } })).toBe(
      'Added a task: Call Sam',
    )
    expect(toolLine({ name: 'brand_new_tool', input: {} })).toBe('brand new tool')
  })
})
