import { describe, expect, it } from 'vitest'
import type { Principal } from '../auth/index.js'
import { FakeLLM } from '../meetings/llm/fake.js'
import { Dictation } from './service.js'
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

  it.each([
    'New paragraph.',
    'Scratch that.',
    'Bullet point milk.',
    '我们应该在星期三发布哈文的报告。',
  ])('still cleans %s', async (text) => {
    const { service, llm } = dictation(text)
    await service.dictate(MEMBER, req)
    expect(llm.calls).toHaveLength(1)
  })

  it('cleans anything longer', async () => {
    const { service, llm } = dictation('um so let us ship it on Wednesday')
    expect(await service.dictate(MEMBER, req)).toMatchObject({ text: 'Cleaned.', cleaned: true })
    expect(llm.calls[0]?.maxTokens).toBeLessThan(100)
  })

  it('logs timings and counts, never the text', async () => {
    const { service, logs } = dictation('the secret launch code is banana')
    await service.dictate(MEMBER, req)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(
      /^dictation \{"audioMs":900,"bytes":10,"asrMs":\d+,"llmMs":\d+,"words":6,"cleaned":true,"mode":"clean","style":"chat","via":"upload"\}$/,
    )
    expect(logs[0]).not.toContain('banana')
  })
})
