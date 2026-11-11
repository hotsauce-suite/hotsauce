import { describe, expect, it } from 'vitest'
import type { Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import { type Chunk, chunkFile, MeetingChat, resolveCitations } from './chat.js'
import { folderPrefix } from './list.js'
import { FakeLLM } from './llm/fake.js'

const chunk = (n: number): Chunk => ({
  space: 'alice',
  path: `meetings/2026/10/m${n}.md`,
  line: n * 10,
  text: `passage ${n}`,
})

describe('resolveCitations', () => {
  const chunks = [chunk(1), chunk(2), chunk(3), chunk(4)]

  it('returns citations in order of first use and renumbers the answer to match', () => {
    const { answer, citations } = resolveCitations(
      'Dana wants SSO [3]. Pricing is due Friday [1][3], per both sides [3, 1].',
      chunks,
    )
    expect(answer).toBe('Dana wants SSO [1]. Pricing is due Friday [2][1], per both sides [1][2].')
    expect(citations).toEqual([
      { space: 'alice', path: 'meetings/2026/10/m3.md', line: 30, text: 'passage 3' },
      { space: 'alice', path: 'meetings/2026/10/m1.md', line: 10, text: 'passage 1' },
    ])
  })

  it('drops numbers that name no passage, and leaves other brackets alone', () => {
    const { answer, citations } = resolveCitations(
      'See [9] and [0], - [ ] todo, [x] [2, 7]',
      chunks,
    )
    expect(answer).toBe('See  and , - [ ] todo, [x] [1]')
    expect(citations.map((c) => c.line)).toEqual([20])
  })

  it('has no citations when the answer cites nothing', () => {
    expect(resolveCitations('No idea.', chunks)).toEqual({ answer: 'No idea.', citations: [] })
  })
})

describe('MeetingChat.ask', () => {
  const alice: Principal = {
    userId: 'dev:alice@example.test',
    email: 'alice@example.test',
    name: 'Alice',
    handle: 'alice',
    isAdmin: false,
  }
  // A meeting whose transcript is the only file: five passages, starting at lines 3, 6, 9, 12, 15.
  const transcript = [
    '# Acme sync: transcript',
    '',
    ...Array.from({ length: 15 }, (_, i) => `[00:00:${String(i).padStart(2, '0')}] **Them:** ${i}`),
  ].join('\n')
  type Deps = ConstructorParameters<typeof MeetingChat>
  const index = {
    // The note's frontmatter names its transcript, as every note Hearth writes does.
    getFile: () => ({ frontmatter: { transcript: 'acme-sync.transcript.md' } }),
    rankPassages: () => [],
    search: () => [],
    listFiles: () => [],
  }
  const git = {
    readFile: async (_space: string, path: string) => {
      if (path.endsWith('.transcript.md')) return { content: transcript, blobOid: 'blob' }
      throw new HearthError('not_found', path)
    },
  }
  const spaces = { visibleSpaces: async () => [], canAccess: () => true }

  it('writes a combined marker back as one marker per citation', async () => {
    const llm = new FakeLLM(() => 'SSO comes first [2, 5]. Pricing follows [5].')
    const chat = new MeetingChat(index as unknown as Deps[0], git, llm, {
      model: 'claude-opus-5-5',
      spaces: spaces as unknown as Deps[3]['spaces'],
    })

    const { answer, citations } = await chat.ask(alice, {
      question: 'What comes first?',
      scope: { space: 'alice', meetingPath: 'meetings/2026/10/acme-sync.md' },
    })

    expect(answer).toBe('SSO comes first [1][2]. Pricing follows [2].')
    expect(citations.map((c) => [c.path, c.line])).toEqual([
      ['meetings/2026/10/acme-sync.transcript.md', 6],
      ['meetings/2026/10/acme-sync.transcript.md', 15],
    ])
  })
})

describe('chunkFile', () => {
  it('cuts a transcript every three lines, citing the first line of each', () => {
    const text = [
      '# Acme sync: transcript',
      '',
      '[00:00:01] **Me:** one',
      '[00:00:02] **Them:** two',
      '[00:00:03] **Me:** three',
      '[00:00:04] **Them:** four',
    ].join('\n')
    expect(chunkFile('alice', 'meetings/a.transcript.md', text)).toEqual([
      {
        space: 'alice',
        path: 'meetings/a.transcript.md',
        line: 3,
        text: '[00:00:01] **Me:** one\n[00:00:02] **Them:** two\n[00:00:03] **Me:** three',
      },
      {
        space: 'alice',
        path: 'meetings/a.transcript.md',
        line: 6,
        text: '[00:00:04] **Them:** four',
      },
    ])
  })

  it('cuts a note by section, with file line numbers that count the frontmatter', () => {
    const text =
      '---\nid: X\ntitle: A\n---\n# A\n\n## Summary\n\n- SSO first\n\n## Next steps\n\n- [ ] Ship\n'
    expect(chunkFile('team', 'meetings/a.md', text).map((c) => [c.line, c.text])).toEqual([
      [5, '# A'],
      [7, '## Summary\n\n- SSO first'],
      [11, '## Next steps\n\n- [ ] Ship'],
    ])
  })
})

describe('folderPrefix', () => {
  it('scopes to a folder under meetings/, given with or without it', () => {
    expect(folderPrefix('clients/acme')).toBe('meetings/clients/acme/')
    expect(folderPrefix('/meetings/clients/')).toBe('meetings/clients/')
    expect(folderPrefix('meetings')).toBe('meetings/')
    expect(folderPrefix('')).toBeUndefined()
    expect(folderPrefix(undefined)).toBeUndefined()
  })
})
