import { describe, expect, it } from 'vitest'
import { FakeLLM } from '../llm/fake.js'
import {
  MAX_SPELLING_CHARS,
  parseSpellingFixes,
  soundsLike,
  spellingFixes,
  spellingPrompt,
} from './spelling.js'

const TRANSCRIPT = [
  '# Sync: transcript',
  '',
  '[00:00:00] **Me:** we met pria at acme bio lab',
  '[00:00:02] **Speaker 1:** sounds good',
  '',
].join('\n')
const WORDS = ['Priya Shah', 'Priya', 'AcmeBioLab']

describe('spellingPrompt', () => {
  it('numbers the transcript lines from 0 after the word list', () => {
    expect(spellingPrompt(TRANSCRIPT, WORDS)).toBe(
      '<word_list>\nPriya Shah\nPriya\nAcmeBioLab\n</word_list>\n\n<cleanup_transcript>\n0: Me: we met pria at acme bio lab\n1: Speaker 1: sounds good\n</cleanup_transcript>',
    )
  })
})

describe('parseSpellingFixes', () => {
  it('keeps safe fixes, spelled as the word list spells them', () => {
    const answer = `Here you go:\n\`\`\`json\n${JSON.stringify([
      { line: 0, from: 'pria', to: 'priya' },
      { line: 0, from: 'acme bio lab', to: 'AcmeBioLab' },
    ])}\n\`\`\``
    expect(parseSpellingFixes(answer, TRANSCRIPT, WORDS)).toEqual([
      { line: 0, from: 'pria', to: 'Priya' },
      { line: 0, from: 'acme bio lab', to: 'AcmeBioLab' },
    ])
  })

  it('drops fixes off the word list, off their line, on missing lines, or malformed', () => {
    const answer = JSON.stringify([
      { line: 0, from: 'met', to: 'meet' },
      { line: 1, from: 'pria', to: 'Priya' },
      { line: 7, from: 'pria', to: 'Priya' },
      { line: '0', from: 'pria', to: 'Priya' },
      { line: 0, from: 'Priya', to: 'Priya' },
      null,
      'pria',
    ])
    expect(parseSpellingFixes(answer, TRANSCRIPT, WORDS)).toEqual([])
    expect(parseSpellingFixes('no idea', TRANSCRIPT, WORDS)).toEqual([])
    expect(parseSpellingFixes('{"line":0}', TRANSCRIPT, WORDS)).toEqual([])
  })
})

describe('spellingFixes', () => {
  it('asks the model once, with the cleanup prompt', async () => {
    const llm = new FakeLLM(() => '[{"line":0,"from":"pria","to":"Priya"}]')
    expect(await spellingFixes(llm, 'claude-haiku-5-5', TRANSCRIPT, WORDS)).toEqual([
      { line: 0, from: 'pria', to: 'Priya' },
    ])
    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0]?.model).toBe('claude-haiku-5-5')
    expect(llm.calls[0]?.system).toMatch(/Never fix anything else/)
  })

  it('skips the call without a word list, lines, or when the transcript is huge', async () => {
    const llm = new FakeLLM(() => '[]')
    expect(await spellingFixes(llm, 'm', TRANSCRIPT, [])).toEqual([])
    expect(await spellingFixes(llm, 'm', '# Empty: transcript\n', WORDS)).toEqual([])
    expect(await spellingFixes(llm, 'm', 'x'.repeat(MAX_SPELLING_CHARS + 1), WORDS)).toEqual([])
    expect(llm.calls).toHaveLength(0)
  })

  it('the fake model fixes nothing by default', async () => {
    expect(await spellingFixes(new FakeLLM(), 'm', TRANSCRIPT, WORDS)).toEqual([])
  })
})

describe('mishearings only', () => {
  const t = '[00:00:00] **Them:** Dana will send a contract to pria\n'
  const words = ['Dana', 'Priya', 'Al']

  it('never swaps one known name for another, or a common word for a name', () => {
    const answer = JSON.stringify([
      { line: 0, from: 'Dana', to: 'Priya' },
      { line: 0, from: 'a', to: 'Al' },
      { line: 0, from: 'contract', to: 'Priya' },
      { line: 0, from: 'pria', to: 'Priya' },
    ])
    expect(parseSpellingFixes(answer, t, words)).toEqual([{ line: 0, from: 'pria', to: 'Priya' }])
  })

  it('soundsLike allows spacing, case and a letter or two', () => {
    expect(soundsLike('acme bio lab', 'AcmeBioLab')).toBe(true)
    expect(soundsLike('pria', 'Priya')).toBe(true)
    expect(soundsLike('a', 'Al')).toBe(false)
    expect(soundsLike('contract', 'Priya')).toBe(false)
  })

  it('fixes a multi-word name whose parts are on the word list too', () => {
    const line = '[00:00:00] **Them:** ask pria shah and dana lee\n'
    const list = ['Priya Shah', 'Priya', 'Shah', 'Dana Lee', 'Dana']
    const answer = JSON.stringify([
      { line: 0, from: 'pria shah', to: 'Priya Shah' },
      { line: 0, from: 'dana lee', to: 'Dana Lee' },
      { line: 0, from: 'dana lee', to: 'Priya Shah' },
    ])
    expect(parseSpellingFixes(answer, line, list)).toEqual([
      { line: 0, from: 'pria shah', to: 'Priya Shah' },
      { line: 0, from: 'dana lee', to: 'Dana Lee' },
    ])
  })
})
