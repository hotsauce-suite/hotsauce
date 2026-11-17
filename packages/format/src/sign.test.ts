import { describe, expect, it } from 'vitest'
import {
  EnvelopeFrontmatter,
  envelopeIdOf,
  envelopePath,
  envelopeProblem,
  parseSigningToken,
  SignField,
  signersUpNext,
} from './sign.js'

const ID = '01JD0000000000000000000000'
const base = {
  id: ID,
  type: 'envelope',
  title: 'Offer letter',
  status: 'draft',
  source: {
    file: '01JD0000000000000000000001',
    space: 'team',
    name: 'offer.pdf',
    sha256: 'a'.repeat(64),
    size: 1000,
    pages: [{ width: 612, height: 792 }],
  },
  signers: [{ id: 's1', name: 'Maya Ortiz', email: 'Maya@Example.com', order: 1 }],
  fields: [
    {
      id: 'f1',
      signer: 's1',
      type: 'signature',
      page: 1,
      x: 0.1,
      y: 0.8,
      width: 0.3,
      height: 0.05,
    },
  ],
  created: '2026-11-16T00:00:00.000Z',
  created_by: 'maya@example.com',
}

describe('sign format', () => {
  it('names envelope files sign/<id>.md and reads the id back', () => {
    expect(envelopePath(ID)).toBe(`sign/${ID}.md`)
    expect(envelopeIdOf(`sign/${ID}.md`)).toBe(ID)
    expect(envelopeIdOf(`sign/${ID}/x.md`)).toBeNull()
    expect(envelopeIdOf(`docs/${ID}.md`)).toBeNull()
  })

  it('parses an envelope, lower-casing emails and filling defaults', () => {
    const fm = EnvelopeFrontmatter.parse(base)
    expect(fm.signers[0]?.email).toBe('maya@example.com')
    expect(fm.signers[0]?.status).toBe('pending')
    expect(fm.fields[0]?.required).toBe(true)
    expect(fm.audit).toEqual([])
  })

  it('keeps a field inside its page', () => {
    expect(SignField.safeParse({ ...base.fields[0], x: 0.9, width: 0.3 }).success).toBe(false)
  })

  it('accepts only PNG data URLs as drawn signatures', () => {
    const ok = SignField.safeParse({
      ...base.fields[0],
      image: 'data:image/png;base64,iVBORw0KGgo=',
    })
    const bad = SignField.safeParse({ ...base.fields[0], image: 'javascript:alert(1)' })
    expect(ok.success).toBe(true)
    expect(bad.success).toBe(false)
  })

  it('says what is missing before an envelope can go out', () => {
    const fm = EnvelopeFrontmatter.parse(base)
    expect(envelopeProblem(fm)).toBeNull()
    expect(envelopeProblem({ ...fm, fields: [] })).toBe('Add a signature field for Maya Ortiz')
    const onPage2 = { ...fm.fields[0], page: 2 } as (typeof fm.fields)[number]
    expect(envelopeProblem({ ...fm, fields: [onPage2] })).toMatch(/page 2/)
    const nobody = { ...fm.fields[0], signer: 'zz' } as (typeof fm.fields)[number]
    expect(envelopeProblem({ ...fm, fields: [nobody] })).toMatch(/nobody/)
    const twice = [...fm.signers, { ...fm.signers[0], id: 's2' } as (typeof fm.signers)[number]]
    expect(envelopeProblem({ ...fm, signers: twice })).toMatch(/twice/)
  })
})

describe('signing links and order (R11, R13)', () => {
  it('reads a token, and refuses anything else', () => {
    const id = '01JC4ENV00000000000000000A'
    const secret = 'a'.repeat(43)
    expect(parseSigningToken(`${id}.s2.${secret}`)).toEqual({ envelope: id, signer: 's2', secret })
    for (const bad of ['', `${id}.s2`, `${id}.S2.${secret}`, `${id}.s2.short`, `x.s2.${secret}`]) {
      expect(parseSigningToken(bad)).toBeNull()
    }
  })

  it('in order, only the first signers still pending are up; copies never are', () => {
    const s = (id: string, order: number, status = 'pending', role = 'signer') =>
      ({ id, order, status, role }) as {
        id: string
        order: number
        status: 'pending' | 'signed'
        role: 'signer' | 'copy'
      }
    const list = [
      s('a', 1, 'signed'),
      s('b', 2),
      s('c', 2),
      s('d', 3),
      s('e', 1, 'pending', 'copy'),
    ]
    expect(signersUpNext(list, 'sequential').map((x) => x.id)).toEqual(['b', 'c'])
    expect(signersUpNext(list, 'parallel').map((x) => x.id)).toEqual(['b', 'c', 'd'])
    expect(signersUpNext([s('a', 1, 'signed')], 'sequential')).toEqual([])
  })
})
