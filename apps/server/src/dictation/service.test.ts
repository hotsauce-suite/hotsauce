import { describe, expect, it } from 'vitest'
import type { Principal } from '../auth/index.js'
import { FakeLLM } from '../meetings/llm/fake.js'
import {
  applyFixes,
  Dictation,
  modelName,
  skipsCleanup,
  thinPunctuation,
  withHeardAs,
} from './service.js'
import { DictationStore } from './store.js'
import type { DictationTranscriber } from './transcriber.js'

const MEMBER: Principal = {
  userId: 'u1',
  email: 'a@example.test',
  name: 'A',
  handle: 'a',
  isAdmin: false,
}

function dictation(text: string, chatNames?: string[]) {
  const llm = new FakeLLM(() => '<cleaned>Cleaned.</cleaned>')
  const logs: string[] = []
  const transcriber: DictationTranscriber = { transcribe: async () => ({ text, durationMs: 900 }) }
  const service = new Dictation({
    store: new DictationStore(':memory:'),
    transcriber,
    llm,
    model: 'm',
    ...(chatNames ? { chatNames } : {}),
    log: (m) => logs.push(m),
  })
  return { service, llm, logs }
}

const req = {
  audio: new Uint8Array(10),
  mimeType: 'audio/mp4',
  mode: 'clean' as const,
  appName: 'Slack',
}

describe('Dictation', () => {
  it('skips the model for three plain words, keeping the chat style and team spellings', async () => {
    const { service, llm } = dictation('Sounds good, thanks.')
    expect(await service.dictate(MEMBER, req)).toMatchObject({
      text: 'Sounds good, thanks',
      cleaned: false,
      ms: { llm: 0 },
    })
    expect(await service.dictate(MEMBER, { ...req, appName: 'Mail' })).toMatchObject({
      text: 'Sounds good, thanks.',
    })
    expect(llm.calls).toHaveLength(0)
    const spelled = dictation('Ask hotsauce.')
    expect(await spelled.service.dictate(MEMBER, { ...req, appName: 'Notes' })).toMatchObject({
      text: 'Ask Hotsauce.',
    })
  })

  it('pastes a plain dictation of up to 40 words as Deepgram gave it, without the model', async () => {
    const text =
      'Can you check whether the Acme report covers the SSO section and send it to Dana before the review on Wednesday afternoon.'
    const { service, llm } = dictation(text)
    expect(await service.dictate(MEMBER, { ...req, appName: 'Notes' })).toMatchObject({
      text,
      cleaned: false,
      ms: { llm: 0 },
    })
    expect(llm.calls).toHaveLength(0)
  })

  it.each([
    'New paragraph.',
    'Scratch that.',
    'Bullet point milk.',
    'Ship it on Tuesday, no wait, Wednesday.',
    'Um, ship it on Wednesday.',
    'We should ship the the report on Wednesday.',
    'First, ship the report. Second, tell Dana.',
    'Ship it on Tuesday, no, wait, Wednesday.',
    'Ship it Tuesday. Wait, no, Wednesday.',
    'Make that Wednesday.',
    'Ship it Tuesday, or rather Wednesday.',
    'Never mind, Wednesday.',
    'Ship the, the report on Wednesday.',
    'Email dana at hotsauce dot com about it.',
    Array.from({ length: 41 }, (_, i) => `word${i}`).join(' '),
    '我们应该在星期三发布哈文的报告并且在周五之前把试点协议发送给普里亚然后起草招聘计划并在团队频道里分享以便大家提前审阅和补充意见谢谢大家的配合和支持我们下周一再碰头讨论细节',
  ])('still cleans %s', async (text) => {
    const { service, llm } = dictation(text)
    await service.dictate(MEMBER, req)
    expect(llm.calls).toHaveLength(1)
  })

  it('uses a cleanup started before key-up when the transcript is the same, and not otherwise', async () => {
    const long = Array.from({ length: 45 }, (_, i) => `word${i}`).join(' ')
    const { service, llm, logs } = dictation(long)
    const context = { mode: 'clean' as const, appName: 'Slack' }
    const early = service.speculate(MEMBER, long, context)
    expect(early).not.toBeNull()
    const heard = {
      ...context,
      transcript: long,
      durationMs: 9_000,
      asrMs: 80,
      bytes: 288_000,
      via: 'stream' as const,
    }
    expect(await service.finish(MEMBER, heard, early)).toMatchObject({
      text: 'Cleaned.',
      cleaned: true,
    })
    expect(llm.calls).toHaveLength(1)
    expect(logs.at(-1)).toContain('"speculated":true')

    const stale = service.speculate(MEMBER, `${long} more`, context)
    await service.finish(MEMBER, heard, stale)
    expect(llm.calls).toHaveLength(3) // the stale one, then a fresh one for the real transcript
    expect(logs.at(-1)).toContain('"speculated":false')

    expect(service.speculate(MEMBER, 'Ship it on Wednesday.', context)).toBeNull() // plain: no model
    expect(service.speculate(MEMBER, long, { ...context, mode: 'literal' })).toBeNull()
  })

  it('cleans anything longer', async () => {
    const { service, llm } = dictation('um so let us ship it on Wednesday')
    expect(await service.dictate(MEMBER, req)).toMatchObject({ text: 'Cleaned.', cleaned: true })
    expect(llm.calls[0]?.maxTokens).toBeLessThan(100)
  })

  it("styles the organization's own chat like Slack", async () => {
    const team = dictation('um the secret launch code is banana', ['acme chat'])
    await team.service.dictate(MEMBER, { ...req, appName: 'Acme Chat' })
    expect(team.logs[0]).toContain('"style":"chat"')
    const other = dictation('um the secret launch code is banana')
    await other.service.dictate(MEMBER, { ...req, appName: 'Acme Chat' })
    expect(other.logs[0]).toContain('"style":"neutral"')
  })

  it('logs timings and counts, never the text', async () => {
    const { service, logs } = dictation('um the secret launch code is banana')
    await service.dictate(MEMBER, req)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(
      /^dictation \{"audioMs":900,"bytes":10,"asrMs":\d+,"llmMs":\d+,"words":7,"cleaned":true,"skipped":false,"speculated":false,"mode":"clean","style":"chat","via":"upload"\}$/,
    )
    expect(logs[0]).not.toContain('banana')
  })
})

describe('skipsCleanup', () => {
  it('skips plain English of up to 40 words', () => {
    expect(
      skipsCleanup('Can you send Dana the report before the review on Wednesday afternoon?'),
    ).toBe(true)
    expect(skipsCleanup('A sentence that mentions the period of the review.')).toBe(false) // a cue word: cleaned, never wrongly skipped
  })

  it('keeps the old three-word rule for other languages', () => {
    expect(skipsCleanup('Enviamos el informe el miércoles por la tarde')).toBe(false) // a non-ASCII letter
    expect(skipsCleanup('Enviamos el informe el miercoles por la tarde', 'es')).toBe(false)
    expect(skipsCleanup('Gracias, perfecto.', 'es')).toBe(true)
    expect(skipsCleanup('Ship it on Wednesday afternoon please.', 'en-GB')).toBe(true)
  })

  it('finds stutters in any script, with or without a comma', () => {
    expect(skipsCleanup('Über über alles.', 'de')).toBe(false)
    expect(skipsCleanup('Send the the report.')).toBe(false)
    expect(skipsCleanup('Send the report, then the deck.')).toBe(true)
  })
})

describe('modelName', () => {
  it('says model ids the way people do, and leaves others alone', () => {
    expect(modelName('claude-haiku-5-5')).toBe('Claude Haiku 5.5')
    expect(modelName('claude-sonnet-5')).toBe('Claude Sonnet 5')
    expect(modelName('gpt-x')).toBe('gpt-x')
  })
})

describe('the cleanup choice in the stream', () => {
  it('starts no early cleanup for a member on Off', () => {
    const { service } = dictation('um so the the report is due Tuesday no wait Wednesday')
    expect(service.speculate(MEMBER, 'um so the the report', { mode: 'clean' })).not.toBeNull()
    service.store.setCleanupChoice(MEMBER.userId, 'off')
    expect(service.speculate(MEMBER, 'um so the the report', { mode: 'clean' })).toBeNull()
  })
})

describe('thin punctuation (P1-P3)', () => {
  it('sends a short run-on to the cleanup', () => {
    const runOn =
      'I talked to the team yesterday we decided to move the launch to Friday can you update the doc'
    expect(thinPunctuation(runOn)).toBe(true)
    expect(skipsCleanup(runOn)).toBe(false)
    expect(skipsCleanup('Ship it on Wednesday')).toBe(true) // under 8 words: fine without a stop
  })

  it('sends a long unbroken run to the cleanup even with a stop at the end', () => {
    const run = `${Array.from({ length: 26 }, () => 'and').join(' ')}.`
    expect(thinPunctuation(run)).toBe(true)
    expect(skipsCleanup(run)).toBe(false)
  })

  it('doesn’t take a dot in a domain or number for a full stop', () => {
    expect(
      thinPunctuation('email the deck to hotsauce.work and tell them we need it by monday'),
    ).toBe(true)
  })

  it('still skips a short dictation that is punctuated (P2)', () => {
    expect(
      skipsCleanup('I talked to the team. We moved the launch to Friday, so update the doc.'),
    ).toBe(true)
  })

  it('cleans anything over three words the Mac heard itself (P3)', () => {
    expect(skipsCleanup('Sounds good thanks', 'en-US', 'mac')).toBe(true)
    expect(skipsCleanup('Sounds good, see you then.', 'en-US', 'mac')).toBe(false)
  })

  it('sends text the Mac heard to the model', async () => {
    const { service, llm } = dictation('')
    await service.cleanText(MEMBER, { text: 'Sounds good, see you then.', mode: 'clean' })
    expect(llm.calls).toHaveLength(1)
  })
})

describe('also heard as (H3, H4)', () => {
  const fixes = [
    { heard: 'Rajeev', write: 'Rajiv' },
    { heard: 'hot sauce', write: 'Hotsauce' },
  ]

  it('writes each heard spelling as its word: whole words, any capitals, possessives kept', () => {
    expect(applyFixes("rajeev's notes for RAJEEV and Rajeevan", fixes)).toBe(
      "Rajiv's notes for Rajiv and Rajeevan",
    )
    expect(applyFixes('Open hot  sauce dictate', fixes)).toBe('Open Hotsauce dictate')
    expect(applyFixes('nothing here', [])).toBe('nothing here')
  })

  it('prefers the longer spelling and never chains fixes', () => {
    expect(
      applyFixes('ask raj eev and raj', [
        { heard: 'raj', write: 'Raj K' },
        { heard: 'raj eev', write: 'Rajiv' },
        { heard: 'Rajiv', write: 'nope' },
      ]),
    ).toBe('ask Rajiv and Raj K')
  })

  it('names the spellings in the prompt dictionary', () => {
    expect(withHeardAs(['rajiv'], fixes)).toEqual(['rajiv (also heard as Rajeev)'])
    expect(withHeardAs(['Rajiv', 'Clerk'], fixes)).toEqual([
      'Rajiv (also heard as Rajeev)',
      'Clerk',
    ])
  })

  it('fixes every dictation, cleaned or skipped, the member’s spelling first', async () => {
    const { service } = dictation('Tell Rajeev thanks.')
    service.store.setWords(MEMBER.userId, ['Rajiv'])
    service.store.setHeardAs(MEMBER.userId, 'Rajiv', ['Rajeev'])
    service.store.setWords('team', ['Rajeev Team'])
    expect(await service.dictate(MEMBER, req)).toMatchObject({
      text: 'Tell Rajiv thanks',
      cleaned: false,
    })
    expect(await service.dictate(MEMBER, { ...req, mode: 'literal' })).toMatchObject({
      text: 'Tell Rajiv thanks.',
    })
    expect(service.fixes(MEMBER.userId)).toEqual([{ heard: 'Rajeev', write: 'Rajiv' }])
  })

  it('tells the model the spellings', async () => {
    const { service, llm } = dictation('um tell Rajeev thanks')
    service.store.setWords(MEMBER.userId, ['Rajiv'])
    service.store.setHeardAs(MEMBER.userId, 'Rajiv', ['Rajeev'])
    await service.dictate(MEMBER, req)
    expect(JSON.stringify(llm.calls[0])).toContain('Rajiv (also heard as Rajeev)')
  })
})
