import { describe, expect, it } from 'vitest'
import type { Principal } from '../auth/index.js'
import { FakeLLM } from '../meetings/llm/fake.js'
import { Dictation, skipsCleanup } from './service.js'
import { DictationStore } from './store.js'
import type { DictationTranscriber } from './transcriber.js'

const MEMBER: Principal = {
  userId: 'u1',
  email: 'a@example.test',
  name: 'A',
  handle: 'a',
  isAdmin: false,
}

function dictation(text: string) {
  const llm = new FakeLLM(() => '<cleaned>Cleaned.</cleaned>')
  const logs: string[] = []
  const transcriber: DictationTranscriber = { transcribe: async () => ({ text, durationMs: 900 }) }
  const service = new Dictation({
    store: new DictationStore(':memory:'),
    transcriber,
    llm,
    model: 'm',
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
    'Email dana at hearth dot com about it.',
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
