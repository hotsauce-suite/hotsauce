import { describe, expect, it } from 'vitest'
import { extractLinks } from './links.js'
import { initialSpaceFiles, parseSpaceConfig, SPACE_LAYOUT, serializeSpaceConfig } from './space.js'

const TEAM = { kind: 'team' } as const
const spaceYaml = (files: Array<{ path: string; content: string }>) =>
  files.find((f) => f.path === '.hearth/space.yaml')?.content ?? ''

describe('initialSpaceFiles', () => {
  it('creates the standard layout', () => {
    expect(initialSpaceFiles('team', TEAM).map((f) => f.path)).toEqual([
      'README.md',
      '.hearth/space.yaml',
      '.hearth/docs/FORMAT.md',
      'docs/.gitkeep',
      'assets/.gitkeep',
    ])
  })

  it('records a team space in space.yaml', () => {
    expect(spaceYaml(initialSpaceFiles('team', TEAM))).toBe('name: team\nschema: 1\nkind: team\n')
  })

  it('records a personal space with its owner', () => {
    const files = initialSpaceFiles('morgan', { kind: 'personal', owner: 'Morgan@Example.test' })
    expect(parseSpaceConfig(spaceYaml(files))).toEqual({
      name: 'morgan',
      schema: 1,
      kind: 'personal',
      owner: 'morgan@example.test',
    })
  })

  it('refuses a personal space without an owner', () => {
    expect(() => initialSpaceFiles('morgan', { kind: 'personal' })).toThrow(/owner/)
  })

  it('names the space in the README, and quotes it in YAML where needed', () => {
    const files = initialSpaceFiles('Ops: lab #2', TEAM)
    expect(parseSpaceConfig(spaceYaml(files)).name).toBe('Ops: lab #2')
    expect(files[0]?.content.startsWith('# Ops: lab #2\n')).toBe(true)
  })

  it('writes text files the way Hearth generates them: LF and a trailing newline', () => {
    for (const { path, content } of initialSpaceFiles('team', TEAM)) {
      if (path.endsWith('.gitkeep')) {
        expect(content).toBe('')
        continue
      }
      expect(content).not.toContain('\r')
      expect(content.endsWith('\n')).toBe(true)
    }
  })

  it('documents the Docs format for agents, without codenames', () => {
    const format = initialSpaceFiles('team', TEAM).find((f) => f.path === '.hearth/docs/FORMAT.md')
    const text = format?.content ?? ''
    for (const term of ['docs/', 'id', 'ULID', 'hearth://', 'assets/YYYY/MM/']) {
      expect(text).toContain(term)
    }
    expect(text).not.toMatch(/Mantle/)
    // The example links in the format doc should themselves be valid links.
    expect(extractLinks(text).map((l) => l.kind)).not.toContain('external')
  })
})

describe('parseSpaceConfig', () => {
  it('reads both kinds', () => {
    expect(parseSpaceConfig('name: team\nschema: 1\nkind: team\n')).toEqual({
      name: 'team',
      schema: 1,
      kind: 'team',
    })
    expect(
      parseSpaceConfig('name: dana\nschema: 1\nkind: personal\nowner: dana@example.test\n'),
    ).toMatchObject({ kind: 'personal', owner: 'dana@example.test' })
  })

  it('lists every problem in its error', () => {
    expect(() => parseSpaceConfig('name: ""\nschema: 2\nkind: shared\n')).toThrow(
      /Invalid \.hearth\/space\.yaml:\n {2}name: .*\n {2}schema: .*\n {2}kind: .*/,
    )
    expect(() => parseSpaceConfig('name: dana\nschema: 1\nkind: personal\n')).toThrow(
      'Invalid .hearth/space.yaml:\n  owner: a personal space needs an owner',
    )
  })

  it('rejects YAML it cannot parse and files that are not a mapping', () => {
    expect(() => parseSpaceConfig('name: [unclosed\n')).toThrow(/Invalid \.hearth\/space\.yaml/)
    expect(() => parseSpaceConfig('')).toThrow(/Invalid \.hearth\/space\.yaml/)
    expect(() => parseSpaceConfig('- team\n')).toThrow(/Invalid \.hearth\/space\.yaml/)
  })
})

describe('serializeSpaceConfig', () => {
  it('writes the keys in a fixed order and leaves out a missing owner', () => {
    expect(serializeSpaceConfig({ name: 'team', schema: 1, kind: 'team' })).toBe(
      'name: team\nschema: 1\nkind: team\n',
    )
    expect(
      serializeSpaceConfig({
        owner: 'sam@example.test',
        kind: 'personal',
        schema: 1,
        name: 'sam',
      }),
    ).toBe('name: sam\nschema: 1\nkind: personal\nowner: sam@example.test\n')
  })

  it('round-trips through parseSpaceConfig', () => {
    const config = {
      name: 'sam',
      schema: 1,
      kind: 'personal',
      owner: 'sam@example.test',
    } as const
    expect(parseSpaceConfig(serializeSpaceConfig(config))).toEqual(config)
  })

  it('refuses to write an invalid config', () => {
    expect(() => serializeSpaceConfig({ name: 'sam', schema: 1, kind: 'personal' })).toThrow(
      /owner/,
    )
    expect(() =>
      serializeSpaceConfig({ name: 'sam', schema: 1, kind: 'personal', owner: 'not-an-email' }),
    ).toThrow(/owner/)
  })
})

describe('SPACE_LAYOUT', () => {
  it('names the top-level folders', () => {
    expect(SPACE_LAYOUT).toEqual({
      docs: 'docs',
      meetings: 'meetings',
      assets: 'assets',
      meta: '.hearth',
      trash: '.trash',
    })
  })
})
