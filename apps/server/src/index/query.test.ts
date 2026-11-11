import { describe, expect, it } from 'vitest'
import { toFtsAnyQuery, toFtsQuery } from './query.js'

describe('toFtsQuery', () => {
  it('quotes bare words as prefix terms, ANDed', () => {
    expect(toFtsQuery('q4 plan')).toBe('"q4"* "plan"*')
    expect(toFtsQuery('  roadmap  ')).toBe('"roadmap"*')
  })

  it('keeps user-quoted phrases exact', () => {
    expect(toFtsQuery('"board meeting" notes')).toBe('"board meeting" "notes"*')
  })

  it('treats an unterminated quote as a phrase to the end', () => {
    expect(toFtsQuery('"board meet')).toBe('"board meet"')
  })

  it('neutralizes FTS5 operators and column filters by quoting them', () => {
    expect(toFtsQuery('a OR b')).toBe('"a"* "OR"* "b"*')
    expect(toFtsQuery('NOT secret')).toBe('"NOT"* "secret"*')
    expect(toFtsQuery('title:plan')).toBe('"title:plan"*')
    expect(toFtsQuery('NEAR(a b)')).toBe('"NEAR(a"* "b)"*')
    expect(toFtsQuery('^start -minus plan*')).toBe('"^start"* "-minus"* "plan*"*')
  })

  it('doubles quotes embedded in a bare word', () => {
    expect(toFtsQuery('it"s')).toBe('"it""s"*')
  })

  it('drops terms with no letters or digits', () => {
    expect(toFtsQuery('&& plan ||')).toBe('"plan"*')
    expect(toFtsQuery('"" "  " "*"')).toBeNull()
  })

  it('returns null for empty or punctuation-only input', () => {
    expect(toFtsQuery('')).toBeNull()
    expect(toFtsQuery('   ')).toBeNull()
    expect(toFtsQuery('* ( ) " : ^ -')).toBeNull()
  })

  it('keeps non-Latin words', () => {
    expect(toFtsQuery('café 東京')).toBe('"café"* "東京"*')
  })
})

describe('toFtsAnyQuery', () => {
  it('ORs the words of a question, dropping stop words and repeats', () => {
    expect(toFtsAnyQuery('What did Dana say about SSO? SSO!')).toBe('"dana"* OR "say"* OR "sso"*')
  })

  it('keeps stop words when nothing else is left', () => {
    expect(toFtsAnyQuery('Who was there?')).toBe('"who"* OR "was"* OR "there"*')
  })

  it('splits on punctuation, so operators and quotes never reach FTS5', () => {
    expect(toFtsAnyQuery('title:plan NEAR("a" b) OR NOT')).toBe(
      '"title"* OR "plan"* OR "near"* OR "b"*',
    )
  })

  it('returns null when there are no words', () => {
    expect(toFtsAnyQuery('?! ...')).toBeNull()
    expect(toFtsAnyQuery('')).toBeNull()
  })
})
