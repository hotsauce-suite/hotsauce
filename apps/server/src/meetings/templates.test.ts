import { describe, expect, it } from 'vitest'
import type { Principal } from '../auth/index.js'
import { HearthError } from '../errors.js'
import {
  loadBuiltinTemplates,
  MeetingTemplates,
  parseTemplate,
  TEMPLATES_DIR,
} from './templates.js'

const ALICE: Principal = {
  userId: 'dev:alice@example.test',
  email: 'alice@example.test',
  name: 'Alice',
  handle: 'alice',
  isAdmin: false,
}

describe('built-in templates', () => {
  const builtins = loadBuiltinTemplates()

  it('are the seven meeting types of PRD §6.5, plus the voice note', () => {
    expect(builtins.map((t) => [t.id, t.name])).toEqual([
      ['brainstorm', 'Brainstorm'],
      ['candidate-interview', 'Candidate interview'],
      ['customer-call', 'Customer call'],
      ['general', 'General'],
      ['one-on-one', '1:1'],
      ['pitch', 'Pitch'],
      ['standup', 'Standup'],
      ['voice-note', 'Voice note'],
    ])
  })

  it('each has a description and instructed sections, ending in a checklist of next steps', () => {
    for (const t of builtins) {
      expect(t.source).toBe('builtin')
      expect(t.description, t.id).not.toBe('')
      expect(t.sections.length, t.id).toBeGreaterThanOrEqual(3)
      for (const s of t.sections) {
        expect(s.heading, t.id).toMatch(/^## /)
        expect(s.instructions, `${t.id}: ${s.title}`).not.toBe('')
        expect(s.instructions).not.toContain('<!--')
      }
      // A voice note has one speaker, so its to-dos have no owner.
      expect(t.sections.at(-1)?.instructions, t.id).toContain(
        t.id === 'voice-note' ? '- [ ] task (due date)' : '- [ ] Owner: task (due date)',
      )
    }
  })
})

describe('parseTemplate', () => {
  it('reads frontmatter, a preamble, sections and their instructions, CRLF or not', () => {
    const text = [
      '---',
      'id: board',
      'name: Board meeting',
      'description: Quarterly board',
      '---',
      '# Board template',
      'Formal tone.',
      '',
      '## Financials',
      '<!-- Revenue, burn,',
      'runway. -->',
      'Keep every figure.',
      '',
      '### Votes ###',
      '<!-- Each resolution and the vote. -->',
    ].join('\r\n')
    expect(parseTemplate(text, 'file-stem', 'team')).toEqual({
      id: 'board',
      name: 'Board meeting',
      description: 'Quarterly board',
      source: 'team',
      preamble: 'Formal tone.',
      sections: [
        {
          heading: '## Financials',
          title: 'Financials',
          instructions: 'Revenue, burn,\nrunway.\nKeep every figure.',
        },
        { heading: '### Votes ###', title: 'Votes', instructions: 'Each resolution and the vote.' },
      ],
    })
  })

  it('falls back to the file stem for the id and name', () => {
    expect(parseTemplate('## Notes\n', 'retro', 'personal')).toMatchObject({
      id: 'retro',
      name: 'retro',
      description: '',
      sections: [{ heading: '## Notes', title: 'Notes', instructions: '' }],
    })
  })
})

/** Just enough of GitStore and SpaceService: a few files per space. */
function fakeDeps(files: Record<string, Record<string, string>>, personal = true) {
  return {
    git: {
      async listTree(space: string, dir?: string) {
        return Object.keys(files[space] ?? {})
          .filter((path) => path.startsWith(`${dir}/`))
          .map((path) => ({ path, type: 'file' as const }))
      },
      async readFile(space: string, path: string) {
        const content = files[space]?.[path]
        if (content === undefined) throw new HearthError('not_found', path)
        return { content, blobOid: 'x' }
      },
    },
    spaces: {
      async visibleSpaces() {
        const team = { name: 'team', kind: 'team' as const, label: 'Team' }
        return personal
          ? [team, { name: 'alice', kind: 'personal' as const, label: 'Personal' }]
          : [team]
      },
    },
  }
}

describe('MeetingTemplates', () => {
  const custom = (name: string) => `---\nname: ${name}\n---\n## Notes\n<!-- all of it -->\n`

  it('merges built-ins with team and personal templates; personal wins, then team', async () => {
    const templates = new MeetingTemplates({
      ...fakeDeps({
        team: {
          [`${TEMPLATES_DIR}/retro.md`]: custom('Team retro'),
          [`${TEMPLATES_DIR}/general.md`]: custom('Team general'),
          [`${TEMPLATES_DIR}/notes.txt`]: 'ignored',
          'docs/other.md': custom('Not a template'),
        },
        alice: { [`${TEMPLATES_DIR}/retro.md`]: custom('My retro') },
      }),
      log: () => {},
    })
    const list = await templates.listTemplates(ALICE)
    expect(list.map((t) => [t.id, t.name, t.source])).toEqual([
      ['brainstorm', 'Brainstorm', 'builtin'],
      ['candidate-interview', 'Candidate interview', 'builtin'],
      ['customer-call', 'Customer call', 'builtin'],
      ['general', 'Team general', 'team'],
      ['one-on-one', '1:1', 'builtin'],
      ['pitch', 'Pitch', 'builtin'],
      ['standup', 'Standup', 'builtin'],
      ['voice-note', 'Voice note', 'builtin'],
      ['retro', 'My retro', 'personal'],
    ])
    expect((await templates.getTemplate(ALICE, 'retro')).sections[0]?.instructions).toBe(
      'all of it',
    )
  })

  it('refuses an unknown template id', async () => {
    const templates = new MeetingTemplates(fakeDeps({}, false))
    await expect(templates.getTemplate(ALICE, 'nope')).rejects.toMatchObject({
      code: 'bad_request',
    })
    expect((await templates.getTemplate(ALICE, 'standup')).source).toBe('builtin')
  })
})
