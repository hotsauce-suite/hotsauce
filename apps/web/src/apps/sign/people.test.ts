import { describe, expect, it } from 'vitest'
import type { DraftPerson, SignField } from '../../api/sign'
import { keptFields, moveUp, nextPersonId, ordered, peopleProblem, shortName } from './people'

const p = (id: string, name: string, email: string, role: 'signer' | 'copy' = 'signer') =>
  ({ id, name, email, order: 1, role }) satisfies DraftPerson

describe('people on a draft', () => {
  it('picks the next unused id', () => {
    expect(nextPersonId([])).toBe('s1')
    expect(nextPersonId([{ id: 's1' }, { id: 's3' }])).toBe('s2')
  })

  it('orders by the list and tidies names and emails', () => {
    const out = ordered([p('s2', '  Maya  Lin ', ' MAYA@x.org '), p('s1', 'Ada', 'ada@x.org')])
    expect(out.map((x) => [x.id, x.order, x.name, x.email])).toEqual([
      ['s2', 1, 'Maya Lin', 'maya@x.org'],
      ['s1', 2, 'Ada', 'ada@x.org'],
    ])
  })

  it('says plainly what is wrong', () => {
    expect(peopleProblem([])).toBe('Add someone to sign')
    expect(peopleProblem([p('s1', '', 'a@x.org')])).toBe('Give each person a name')
    expect(peopleProblem([p('s1', 'A', 'nope')])).toMatch(/isn’t an email/)
    expect(peopleProblem([p('s1', 'A', 'a@x.org'), p('s2', 'B', 'A@x.org')])).toMatch(/twice/)
    expect(peopleProblem([p('s1', 'A', 'a@x.org', 'copy')])).toBe('Add someone to sign')
    expect(peopleProblem([p('s1', 'A', 'a@x.org'), p('s2', 'B', 'b@x.org', 'copy')])).toBeNull()
  })

  it('drops the fields of anyone removed or only getting a copy', () => {
    const f = (id: string, signer: string) => ({ id, signer }) as SignField
    const fields = [f('f1', 's1'), f('f2', 's2'), f('f3', 's3')]
    expect(
      keptFields(fields, [p('s1', 'A', 'a@x.org'), p('s2', 'B', 'b@x.org', 'copy')]).map(
        (x) => x.id,
      ),
    ).toEqual(['f1'])
  })

  it('moves a person up, and leaves the first where it is', () => {
    expect(moveUp(['a', 'b', 'c'], 2)).toEqual(['a', 'c', 'b'])
    expect(moveUp(['a', 'b'], 0)).toEqual(['a', 'b'])
  })

  it('labels a field with a first name', () => {
    expect(shortName(' Maya Lin ')).toBe('Maya')
  })
})
