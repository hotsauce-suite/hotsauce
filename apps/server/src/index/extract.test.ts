import { describe, expect, it } from 'vitest'
import { extractDoc, isIndexable, kindOf } from './extract.js'

const title = (text: string, path = 'docs/some-file.md') => extractDoc(path, text).title

describe('extractDoc title', () => {
  it('prefers frontmatter title', () => {
    expect(title('---\ntitle: Q4 plan\n---\n# Heading\n')).toBe('Q4 plan')
  })

  it('reads quoted and CRLF frontmatter titles', () => {
    expect(title('---\r\ntitle: "Q4: the \\"real\\" plan"\r\n---\r\nbody')).toBe(
      'Q4: the "real" plan',
    )
    expect(title("---\ntitle: 'It''s here'\n---\n")).toBe("It's here")
  })

  it('accepts a numeric frontmatter title', () => {
    expect(title('---\ntitle: 1984\n---\n')).toBe('1984')
  })

  it('falls back to the first H1 when the frontmatter has no usable title', () => {
    expect(title('---\nid: 01J\n---\n\nIntro\n\n# Real title\n\n# Second\n')).toBe('Real title')
    expect(title('---\ntitle: "  "\n---\n# Heading\n')).toBe('Heading')
    expect(title('---\ntitle: [a, b]\n---\n# Heading\n')).toBe('Heading')
  })

  it('reads an H1 with no frontmatter, stripping a closing # sequence', () => {
    expect(title('# Launch notes ##\n')).toBe('Launch notes')
    expect(title('   # Indented  \n')).toBe('Indented')
    expect(title('# C#\n')).toBe('C#')
  })

  it('ignores H2s, #hashtags and headings inside fenced code', () => {
    const text = [
      '## Not this',
      '#tag',
      '```bash',
      '# install deps',
      '```',
      '~~~~',
      '# nor this',
      '```',
      '# still in the tilde fence',
      '~~~~',
      '# Actual',
    ].join('\n')
    expect(title(text)).toBe('Actual')
  })

  it('falls back to the filename without .md', () => {
    expect(title('just text\n', 'docs/team/q4-plan.md')).toBe('q4-plan')
    expect(title('', 'README.MD')).toBe('README')
  })

  it('survives broken YAML by ignoring the frontmatter', () => {
    const doc = extractDoc('docs/x.md', '---\ntitle: [unclosed\n---\n# From H1\n')
    expect(doc.title).toBe('From H1')
    expect(doc.body).toBe('# From H1\n')
  })

  it('treats an unterminated frontmatter block as body text', () => {
    expect(title('---\ntitle: nope\n# Heading\n')).toBe('Heading')
  })
})

describe('extractDoc id and body', () => {
  it('reads a string id and strips the frontmatter from the body', () => {
    const doc = extractDoc('docs/a.md', '---\nid: 01JABC\ntitle: A\n---\n# A\n\nText\n')
    expect(doc.id).toBe('01JABC')
    expect(doc.body).toBe('# A\n\nText\n')
  })

  it('handles an empty frontmatter block', () => {
    const doc = extractDoc('docs/a.md', '---\n---\nText\n')
    expect(doc.id).toBeNull()
    expect(doc.body).toBe('Text\n')
  })

  it('returns the parsed frontmatter, or null when there is none or it is not a mapping', () => {
    expect(extractDoc('meetings/a.md', '---\nid: X\nattendees: [a, b]\n---\n').frontmatter).toEqual(
      { id: 'X', attendees: ['a', 'b'] },
    )
    expect(extractDoc('docs/a.md', '---\n---\nText\n').frontmatter).toEqual({})
    expect(extractDoc('docs/a.md', '# No frontmatter\n').frontmatter).toBeNull()
    expect(extractDoc('docs/a.md', '---\ntitle: [unclosed\n---\n').frontmatter).toBeNull()
    expect(extractDoc('docs/a.md', '---\n- a list\n---\n').frontmatter).toBeNull()
  })

  it('has a null id when absent or not a string', () => {
    expect(extractDoc('docs/a.md', '# A\n').id).toBeNull()
    expect(extractDoc('docs/a.md', '---\nid: 42\n---\n').id).toBeNull()
  })
})

describe('kindOf', () => {
  it('uses the top-level folder', () => {
    expect(kindOf('docs/a.md')).toBe('docs')
    expect(kindOf('docs/deep/er/a.md')).toBe('docs')
    expect(kindOf('meetings/2026/10/standup.md')).toBe('meeting')
    expect(kindOf('meetings/2026/10/standup.transcript.md')).toBe('transcript')
    expect(kindOf('meetings/clients/acme/2026-10-07-sync.Transcript.MD')).toBe('transcript')
    expect(kindOf('README.md')).toBe('other')
    expect(kindOf('docs.md')).toBe('other')
    expect(kindOf('crm/acme.md')).toBe('other')
    expect(kindOf('Docs/a.md')).toBe('other')
  })
})

describe('isIndexable', () => {
  it('accepts markdown files only', () => {
    expect(isIndexable('docs/a.md')).toBe(true)
    expect(isIndexable('docs/A.MD')).toBe(true)
    expect(isIndexable('README.md')).toBe(true)
    expect(isIndexable('assets/2026/10/logo.png')).toBe(false)
    expect(isIndexable('docs/notes.markdown')).toBe(false)
    expect(isIndexable('docs/md')).toBe(false)
  })

  it('skips hidden folders such as metadata and trash', () => {
    expect(isIndexable('.hearth/docs/FORMAT.md')).toBe(false)
    expect(isIndexable('.trash/2026-10-07/docs/a.md')).toBe(false)
    expect(isIndexable('docs/.obsidian/notes.md')).toBe(false)
  })
})
