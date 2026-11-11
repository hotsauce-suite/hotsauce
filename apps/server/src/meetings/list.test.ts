import { describe, expect, it } from 'vitest'
import { matchesCompany, matchesPerson } from './list.js'

const frontmatter = {
  attendees: ['Alice <alice@example.test>', 'Jordan Lee <Jordan@Acme.com>', 'dana@acme.com'],
  companies: ['notacme.com', 'Globex.com'],
}

describe('matchesPerson', () => {
  it("matches an attendee's whole email, in `Name <email>` or bare, ignoring case", () => {
    expect(matchesPerson(frontmatter, 'jordan@acme.com')).toBe(true)
    expect(matchesPerson(frontmatter, 'DANA@ACME.COM')).toBe(true)
    expect(matchesPerson(frontmatter, ' alice@example.test ')).toBe(true)
    expect(matchesPerson(frontmatter, undefined)).toBe(true)
  })

  it('never matches part of an email, or a name', () => {
    expect(matchesPerson({ attendees: ['Jordan Lee <jordan@acme.com>'] }, 'dan@acme.com')).toBe(
      false,
    )
    expect(matchesPerson({ attendees: ['jordan@acme.com'] }, 'dan@acme.com')).toBe(false)
    expect(matchesPerson(frontmatter, 'Jordan Lee')).toBe(false)
    expect(matchesPerson(frontmatter, 'acme.com')).toBe(false)
    expect(matchesPerson(null, 'dana@acme.com')).toBe(false)
  })
})

describe('matchesCompany', () => {
  it('matches a whole company domain, ignoring case', () => {
    expect(matchesCompany(frontmatter, 'globex.com')).toBe(true)
    expect(matchesCompany(frontmatter, 'NOTACME.COM')).toBe(true)
    expect(matchesCompany(frontmatter, undefined)).toBe(true)
  })

  it('never matches part of a domain', () => {
    expect(matchesCompany(frontmatter, 'acme.com')).toBe(false)
    expect(matchesCompany(frontmatter, 'globex')).toBe(false)
  })
})
