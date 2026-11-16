import { describe, expect, it } from 'vitest'
import {
  CommentFrontmatter,
  commentPath,
  commentRefOf,
  findMentions,
  mentionedEmails,
} from './comments.js'

const ADA = { email: 'ada@example.test', name: 'Ada Lovelace', handle: 'ada' }
const ADAM = { email: 'adam@example.test', name: 'Adam Smith', handle: 'adam' }
const JO = { email: 'jo@partner.test', name: 'Jo Park', handle: 'jo-partner-test' }
const JO2 = { email: 'jo@example.test', name: 'Jo Park', handle: 'jo' }
const TEAM = [ADA, ADAM, JO]

describe('comment files', () => {
  it('a path names its item and comment, and nothing else is a comment', () => {
    const item = '01JD0000000000000000000001'
    const id = '01JD0000000000000000000002'
    expect(commentPath(item, id)).toBe(`.hearth/comments/${item}/${id}.md`)
    expect(commentRefOf(commentPath(item, id))).toEqual({ item, id })
    expect(commentRefOf(`.hearth/comments/${item}/notes.md`)).toBeNull()
    expect(commentRefOf(`.hearth/comments/${item}/deep/${id}.md`)).toBeNull()
    expect(commentRefOf(`.hearth/comments/../${id}.md`)).toBeNull()
    expect(commentRefOf(`docs/${id}.md`)).toBeNull()
  })

  it('frontmatter defaults mentions and keeps unknown keys', () => {
    const fm = CommentFrontmatter.parse({
      id: '01JD0000000000000000000002',
      type: 'comment',
      item: 'pilot-plan',
      author: 'ada@example.test',
      created: '2026-11-16T10:00:00.000Z',
      extra: 1,
    })
    expect(fm.mentions).toEqual([])
    expect(fm.extra).toBe(1)
    expect(CommentFrontmatter.safeParse({ ...fm, item: '../x' }).success).toBe(false)
  })
})

describe('findMentions (R4)', () => {
  it('finds a full name, a handle and a first name, whatever the case', () => {
    expect(mentionedEmails('@Ada Lovelace can you look?', TEAM)).toEqual([ADA.email])
    expect(mentionedEmails('cc @adam and @ADA', TEAM)).toEqual([ADAM.email, ADA.email])
    expect(mentionedEmails('thanks @Jo!', TEAM)).toEqual([JO.email])
  })

  it('prefers the longest name, and stops at the end of the word', () => {
    expect(mentionedEmails('@Adam Smith', TEAM)).toEqual([ADAM.email])
    expect(mentionedEmails('@Adamant', TEAM)).toEqual([])
    expect(mentionedEmails('@Ada’s draft, @Ada.', TEAM)).toEqual([ADA.email])
  })

  it('leaves a non-member, an email address and a shared name as plain text', () => {
    expect(mentionedEmails('@Grace Hopper and @everyone', TEAM)).toEqual([])
    expect(mentionedEmails('write to ada@example.test', TEAM)).toEqual([])
    // Two members called Jo Park: the name alone picks neither, a handle picks one.
    expect(mentionedEmails('@Jo Park', [ADA, JO, JO2])).toEqual([])
    expect(mentionedEmails('@jo-partner-test', [ADA, JO, JO2])).toEqual([JO.email])
  })

  it('reports where each mention sits', () => {
    const text = 'Hi @Ada Lovelace, meet @adam'
    expect(findMentions(text, TEAM).map((m) => text.slice(m.from, m.to))).toEqual([
      '@Ada Lovelace',
      '@adam',
    ])
  })
})
