import { describe, expect, it, vi } from 'vitest'
import { HearthError } from '../errors.js'
import { FakeLLM } from '../meetings/llm/fake.js'
import { cleanTranscript, cleanupTokenBudget } from './cleaner.js'

const input = {
  transcript: 'um ship it on Tuesday no wait Wednesday',
  style: 'neutral' as const,
  dictionary: [],
}

describe('cleanTranscript', () => {
  it('returns the model’s cleaned text', async () => {
    const llm = new FakeLLM(() => '<cleaned>Ship it on Wednesday.</cleaned>')
    expect(await cleanTranscript(llm, 'claude-haiku-5-5', input)).toEqual({
      text: 'Ship it on Wednesday.',
      cleaned: true,
    })
    expect(llm.calls[0]?.model).toBe('claude-haiku-5-5')
    expect(llm.calls[0]?.messages[0]?.content).toContain('<transcript>')
  })

  it('falls back to the raw transcript when the model fails', async () => {
    const log = vi.fn()
    const llm = new FakeLLM(() => {
      throw new HearthError('llm_error', 'Claude is busy')
    })
    expect(await cleanTranscript(llm, 'm', input, log)).toEqual({
      text: input.transcript,
      cleaned: false,
    })
    expect(log).toHaveBeenCalledWith('dictation cleanup failed: llm_error Claude is busy')
  })

  it('falls back when the answer is far longer than the transcript (it answered instead)', async () => {
    const llm = new FakeLLM(
      () => `<cleaned>${'Here is a poem about Wednesdays. '.repeat(20)}</cleaned>`,
    )
    expect(await cleanTranscript(llm, 'm', input, () => {})).toEqual({
      text: input.transcript,
      cleaned: false,
    })
  })

  it('falls back when the answer has no <cleaned> tag (it answered the question)', async () => {
    const llm = new FakeLLM(() => 'Wednesday.')
    expect(await cleanTranscript(llm, 'm', input, () => {})).toEqual({
      text: input.transcript,
      cleaned: false,
    })
  })

  it('falls back when the model is slower than the budget', async () => {
    const log = vi.fn()
    const llm = new FakeLLM(
      () =>
        new Promise<string>((resolve) => setTimeout(() => resolve('<cleaned>late</cleaned>'), 200)),
    )
    expect(await cleanTranscript(llm, 'm', input, log, 20)).toEqual({
      text: input.transcript,
      cleaned: false,
    })
    expect(log).toHaveBeenCalledWith('dictation cleanup failed: llm_error timed out')
  })

  it('skips the model for an empty transcript', async () => {
    const llm = new FakeLLM()
    expect(await cleanTranscript(llm, 'm', { ...input, transcript: '  ' })).toEqual({
      text: '',
      cleaned: false,
    })
    expect(llm.calls).toHaveLength(0)
  })
})

describe('cleanupTokenBudget', () => {
  it('allows a token per two characters for Latin text and one per character otherwise', () => {
    expect(cleanupTokenBudget('a'.repeat(400))).toBe(264)
    expect(cleanupTokenBudget('안녕하세요 '.repeat(60))).toBe(64 + 360)
    expect(cleanupTokenBudget('x'.repeat(20_000))).toBe(4_000)
  })

  it('a cut-off answer falls back to the raw transcript', async () => {
    const llm = new FakeLLM(() => '<cleaned>Ship it on')
    expect(await cleanTranscript(llm, 'm', input, () => {})).toEqual({
      text: input.transcript,
      cleaned: false,
    })
  })
})
