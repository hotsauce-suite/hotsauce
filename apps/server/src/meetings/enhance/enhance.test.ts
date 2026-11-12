import { describe, expect, it } from 'vitest'
import { HearthError } from '../../errors.js'
import { FakeLLM } from '../llm/fake.js'
import { loadBuiltinTemplates } from '../templates.js'
import { assembleEnhancedNote } from './assemble.js'
import {
  cleanModelOutput,
  Enhancer,
  MISSING_NOTES_HEADING,
  splitSpeakers,
  splitTitle,
  withAllRawLines,
  withoutOutsideImages,
} from './enhancer.js'
import { blobOidOf, hasPlaceholderTitle } from './note.js'
import { buildEnhancePrompt, type EnhanceInput } from './prompt.js'

const FRONTMATTER = '---\nid: X\ntype: meeting\ntitle: Acme sync\n---\n'

describe('assembleEnhancedNote', () => {
  it("keeps the member's lines verbatim and ranges every other line as AI", () => {
    const { text, aiRanges } = assembleEnhancedNote({
      frontmatterText: FRONTMATTER,
      rawNotes: 'Dana wants SSO\n  - pricing by Fri  \n',
      modelMarkdown: [
        '# Acme sync', // 1 AI
        '', // 2 AI (blank lines are not the member's)
        '## Summary', // 3 AI
        '', // 4 AI
        'Dana wants SSO', // 5 member
        '- They need it before rollout', // 6 AI
        '  - pricing by Fri', // 7 member: compared trimmed, indent kept
        '- Next call Tuesday', // 8 AI
        '',
      ].join('\n'),
    })
    expect(aiRanges).toEqual([
      [1, 4],
      [6, 6],
      [8, 8],
    ])
    expect(text).toBe(
      `${FRONTMATTER}# Acme sync\n\n## Summary\n\nDana wants SSO\n- They need it before rollout\n  - pricing by Fri\n- Next call Tuesday\n`,
    )
  })

  it('keeps a CRLF note CRLF and matches raw notes typed with CRLF', () => {
    const frontmatterText = FRONTMATTER.replace(/\n/g, '\r\n')
    const { text, aiRanges } = assembleEnhancedNote({
      frontmatterText,
      rawNotes: 'first\r\nsecond\r\n',
      modelMarkdown: '## Notes\r\nfirst\r\n- added\nsecond\r\n',
    })
    expect(text).toBe(`${frontmatterText}## Notes\r\nfirst\r\n- added\r\nsecond\r\n`)
    expect(aiRanges).toEqual([
      [1, 1],
      [3, 3],
    ])
  })

  it('ranges the whole body as AI when there are no raw notes', () => {
    const { aiRanges } = assembleEnhancedNote({
      frontmatterText: FRONTMATTER,
      rawNotes: '   \n\n',
      modelMarkdown: '## Summary\n\n- one\n- two\n',
    })
    expect(aiRanges).toEqual([[1, 4]])
  })

  it('works without frontmatter', () => {
    expect(
      assembleEnhancedNote({ frontmatterText: '', rawNotes: 'mine', modelMarkdown: 'mine\nai' }),
    ).toEqual({ text: 'mine\nai\n', aiRanges: [[2, 2]] })
  })
})

const template = loadBuiltinTemplates().find((t) => t.id === 'customer-call')
if (!template) throw new Error('customer-call template missing')

const INPUT: EnhanceInput = {
  title: 'Acme sync',
  template,
  rawNotes: 'Dana wants SSO\n- pricing by Fri',
  transcript: [
    {
      track: 'them',
      speaker: 'Them',
      at: 5_000,
      durationMs: 1000,
      text: 'We need SSO.',
      final: true,
    },
    { track: 'me', speaker: 'Me', at: 1_000, durationMs: 1000, text: 'Hi Dana.', final: true },
    { track: 'me', speaker: 'Me', at: 2_000, durationMs: 1000, text: 'partial', final: false },
  ],
  attendees: ['Alice Example <alice@example.test>', 'Dana Lee <dana@acme.com>'],
  calendar: { title: 'Acme sync', description: 'Agenda: SSO timeline' },
}

describe('buildEnhancePrompt', () => {
  const { system, user } = buildEnhancePrompt(INPUT)

  it('tells the model to keep raw-notes lines verbatim and in order, following the template', () => {
    expect(system).toContain('Keep every line of the raw notes exactly as written')
    expect(system).toContain('in their original order')
    expect(system).toContain("following the template's sections")
  })

  it('includes every template section with its instructions, and the attendees', () => {
    for (const section of template.sections) {
      expect(user).toContain(`${section.heading}\n${section.instructions}`)
    }
    expect(user).toContain('<template name="Customer call">')
    expect(user).toContain('- Alice Example <alice@example.test>\n- Dana Lee <dana@acme.com>')
    expect(user).toContain('Calendar description:\nAgenda: SSO timeline')
  })

  it('passes the raw notes verbatim and the final transcript lines', () => {
    expect(user).toContain('<raw_notes>\nDana wants SSO\n- pricing by Fri\n</raw_notes>')
    expect(user).toContain(
      '<transcript>\n[00:00:05] **Them:** We need SSO.\n[00:00:01] **Me:** Hi Dana.\n</transcript>',
    )
    expect(user).not.toContain('partial')
  })

  it('names the note-taker and the date, so action items say who and when, never "Me"', () => {
    const prompt = buildEnhancePrompt({
      ...INPUT,
      noteTaker: 'Ada Lovelace',
      date: '2026-11-10T09:00:00-05:00',
    })
    expect(prompt.user).toContain('Date: 2026-11-10T09:00:00-05:00\nNote-taker: Ada Lovelace')
    expect(prompt.system).toContain('Write the note-taker\'s name, never "Me"')
    expect(buildEnhancePrompt(INPUT).user).not.toContain('Note-taker:')
  })

  it('says so when no notes were taken', () => {
    expect(buildEnhancePrompt({ ...INPUT, rawNotes: '' }).user).toContain(
      'The note-taker wrote nothing during this meeting.',
    )
  })
})

describe('Enhancer', () => {
  it('calls the model with the enhance model and returns the body under the title', async () => {
    const llm = new FakeLLM(
      () => '```markdown\n# Acme sync\n\n## Summary\nDana wants SSO\n- pricing by Fri\n```',
    )
    const enhancer = new Enhancer(llm, { model: 'claude-sonnet-5-5' })
    const { markdown, usage } = await enhancer.enhance(INPUT)
    expect(markdown).toBe('# Acme sync\n\n## Summary\nDana wants SSO\n- pricing by Fri\n')
    expect(usage.output).toBeGreaterThan(0)
    expect(llm.calls[0]).toMatchObject({
      model: 'claude-sonnet-5-5',
      system: buildEnhancePrompt(INPUT).system,
    })
    expect(llm.calls[0]?.messages).toEqual([
      { role: 'user', content: buildEnhancePrompt(INPUT).user },
    ])
  })

  it("puts raw-notes lines the model dropped under their own heading, so they're never lost", async () => {
    const enhancer = new Enhancer(new FakeLLM(() => '## Summary\n- something'), { model: 'm' })
    const { markdown } = await enhancer.enhance(INPUT)
    expect(markdown).toBe(
      `# Acme sync\n\n## Summary\n- something\n\n${MISSING_NOTES_HEADING}\n\nDana wants SSO\n- pricing by Fri\n`,
    )
  })

  it('refuses an empty answer', async () => {
    const enhancer = new Enhancer(new FakeLLM(() => '  \n# Acme sync\n'), { model: 'm' })
    const failure = await enhancer.enhance(INPUT).catch((e) => e)
    expect(failure).toBeInstanceOf(HearthError)
    expect(failure.code).toBe('llm_error')
  })

  it('cleans only a fence around everything and a leading title', () => {
    expect(cleanModelOutput('## A\n```js\nx\n```\n')).toBe('## A\n```js\nx\n```')
    expect(withAllRawLines('a\nb', 'b\na\n')).toBe('a\nb')
  })
})

describe('naming a voice note', () => {
  it('asks for a title only when told to, and puts it in the heading', async () => {
    expect(buildEnhancePrompt(INPUT).user).not.toContain('This note has no title yet')
    const llm = new FakeLLM(() => 'Title: "Pricing ideas for Acme."\n\n## Summary\n- tiers')
    const enhancer = new Enhancer(llm, { model: 'm' })
    const named = await enhancer.enhance({ ...INPUT, rawNotes: '', nameIt: true })
    expect(llm.calls[0]?.messages[0]?.content).toContain('This note has no title yet')
    expect(named.title).toBe('Pricing ideas for Acme')
    expect(named.markdown).toBe('# Pricing ideas for Acme\n\n## Summary\n- tiers\n')
  })

  it('finds the Title line inside a fence around the whole answer', async () => {
    const llm = new FakeLLM(() => '```markdown\nTitle: Fenced\n\n## Summary\n- x\n```')
    const named = await new Enhancer(llm, { model: 'm' }).enhance({
      ...INPUT,
      rawNotes: '',
      nameIt: true,
    })
    expect(named.title).toBe('Fenced')
    expect(named.markdown).toBe('# Fenced\n\n## Summary\n- x\n')
  })

  it('keeps the old title when the model gives none', async () => {
    const enhancer = new Enhancer(new FakeLLM(() => '## Summary\n- tiers'), { model: 'm' })
    const named = await enhancer.enhance({ ...INPUT, rawNotes: '', nameIt: true })
    expect(named.title).toBeUndefined()
    expect(named.markdown).toBe('# Acme sync\n\n## Summary\n- tiers\n')
  })

  it('splits a Title line off, cleaning marks and capping its length', () => {
    expect(splitTitle('Title: **Big idea**\nbody')).toEqual({ title: 'Big idea', rest: 'body' })
    expect(splitTitle('Title:\nbody')).toEqual({ title: undefined, rest: 'body' })
    expect(splitTitle('## Summary\nx')).toEqual({ title: undefined, rest: '## Summary\nx' })
    expect(splitTitle(`Title: ${'a'.repeat(300)}`).title).toHaveLength(120)
  })

  it('recognises only the placeholder title a voice note starts with', () => {
    expect(hasPlaceholderTitle('10:12 PM Voice note')).toBe(true)
    expect(hasPlaceholderTitle('9:05 am Voice note')).toBe(true)
    expect(hasPlaceholderTitle('22:12 Voice note')).toBe(true)
    expect(hasPlaceholderTitle('Pricing ideas')).toBe(false)
    expect(hasPlaceholderTitle('My voice note')).toBe(false)
    expect(hasPlaceholderTitle('10:12 PM Meeting')).toBe(false)
  })
})

describe('outside images', () => {
  const planted = '![](https://x.example/p?d=secret)'
  const rawNotes = `Dana wants SSO\nLogo ${planted}\n`

  it("removes absolute images from the model's lines, keeps the member's lines and relative images", async () => {
    const answer = [
      '## Summary',
      'Dana wants SSO',
      `Logo ${planted}`, // the member's own line, verbatim
      `- They want SSO ${planted} before rollout`,
      '- Architecture: ![arch](./assets/a.png)',
      '- <img src="https://x.example/p.png" alt="chart"> and <IMG SRC=\'./b.png\'>',
      '- ![](//x.example/a.png)![](data:image/png;base64,AAAA)![x](HTTP://X.EXAMPLE/b "t")',
    ].join('\n')
    const enhancer = new Enhancer(new FakeLLM(() => answer), { model: 'm' })

    const { markdown } = await enhancer.enhance({ ...INPUT, rawNotes })

    expect(markdown.split('\n')).toEqual([
      '# Acme sync',
      '',
      '## Summary',
      'Dana wants SSO',
      `Logo ${planted}`,
      '- They want SSO  before rollout',
      '- Architecture: ![arch](./assets/a.png)',
      "-  and <IMG SRC='./b.png'>",
      '- ',
      '',
    ])
    // ai_ranges describe the lines as written.
    const { text, aiRanges } = assembleEnhancedNote({
      frontmatterText: FRONTMATTER,
      rawNotes,
      modelMarkdown: markdown,
    })
    const body = text.slice(FRONTMATTER.length).split('\n').slice(0, -1)
    const own = rawNotes.split('\n').filter(Boolean)
    body.forEach((line, i) => {
      const ai = aiRanges.some(([from, to]) => i + 1 >= from && i + 1 <= to)
      expect(ai, `line ${i + 1}: ${line}`).toBe(!own.includes(line))
    })
    expect(aiRanges).toEqual([
      [1, 3],
      [6, 9],
    ])
  })

  it('catches the other ways markdown writes an image', () => {
    const markdown = [
      '# T',
      '',
      '- a chart ![chart][c] and ![the', // reference image; alt text across two lines
      'whole thing](https://x.example/q) here',
      '- escaped ![](https\\://x.example/r) and encoded ![](https&#58;//x.example/s)',
      '',
      '[c]: https://x.example/p',
      '',
      '```',
      '![](https://x.example/in-code)',
      '```',
    ].join('\n')
    expect(withoutOutsideImages(markdown, '').split('\n')).toEqual([
      '# T',
      '',
      '- a chart  and ',
      ' here',
      '- escaped  and encoded ',
      '',
      '[c]: https://x.example/p',
      '',
      '```',
      '![](https://x.example/in-code)',
      '```',
    ])
  })

  it("never cuts into the member's line, even when an image runs through it", () => {
    const markdown = `# T\n\n- ![\nDana wants SSO\n](https://x.example/p)\n`
    expect(withoutOutsideImages(markdown, 'Dana wants SSO')).toBe('# T\n\n- \nDana wants SSO\n\n')
  })
})

describe('note helpers', () => {
  it('hashes like git hash-object', () => {
    // printf 'hello\n' | git hash-object --stdin
    expect(blobOidOf('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
  })
})

describe('splitSpeakers', () => {
  it('keeps only guesses for labels in the transcript and names on the attendee list', () => {
    const { guesses, rest } = splitSpeakers(
      'Speakers: Speaker 1 = Priya Shah; Speaker 2 = ?; Speaker 3 = dana lee; Speaker 9 = Sam\n\n## Summary',
      ['Speaker 1', 'Speaker 2', 'Speaker 3'],
      ['Priya Shah <priya@acme.com>', 'Dana Lee <dana@acme.com>', 'sam@acme.com'],
    )
    expect(guesses).toEqual({ 'Speaker 1': 'Priya Shah', 'Speaker 3': 'Dana Lee' })
    expect(rest.trim()).toBe('## Summary')
  })

  it('leaves text without a Speakers line alone', () => {
    expect(splitSpeakers('## Summary', ['Speaker 1'], ['A B'])).toEqual({
      guesses: {},
      rest: '## Summary',
    })
  })
})

describe('the Speakers line, however the model wraps it', () => {
  const transcript = [
    { track: 'them' as const, speaker: 'Speaker 1', at: 0, durationMs: 0, text: 'hi', final: true },
  ]
  const input = (nameIt: boolean) => ({
    title: '10:12 PM Voice note',
    template: { id: 'general', name: 'General', sections: [], preamble: '' } as never,
    rawNotes: '',
    transcript,
    attendees: ['Dana Lee <dana@acme.com>'],
    ...(nameIt ? { nameIt: true } : {}),
  })

  it('takes it out of a fenced answer', async () => {
    const llm = new FakeLLM(
      () => '```markdown\nSpeakers: Speaker 1 = Dana Lee\n\n## Summary\n- x\n```',
    )
    const out = await new Enhancer(llm, { model: 'm' }).enhance(input(false))
    expect(out.markdown).not.toContain('Speakers:')
    expect(out.speakerGuesses).toEqual({ 'Speaker 1': 'Dana Lee' })
  })

  it('reads Title and Speakers in either order', async () => {
    const llm = new FakeLLM(
      () => 'Speakers: Speaker 1 = Dana Lee\nTitle: Pilot plan\n\n## Summary\n- x',
    )
    const out = await new Enhancer(llm, { model: 'm' }).enhance(input(true))
    expect(out.title).toBe('Pilot plan')
    expect(out.markdown).not.toMatch(/Title:|Speakers:/)
    expect(out.speakerGuesses).toEqual({ 'Speaker 1': 'Dana Lee' })
  })
})
