import { describe, expect, it } from 'vitest'
import { parseFrontmatter } from './frontmatter.js'
import { DocFrontmatter, MeetingFrontmatter, SpaceConfig } from './schemas.js'

const meeting = `---
id: 01JA3B7K2N8X4P6Q9R0S5T1UVW
type: meeting
title: Acme sync
date: 2026-10-07T15:00:00-04:00
duration_min: 32
attendees:
  - Morgan Holland <morgan@example.test>
  - Dana Lee <dana@acme.com>
companies: [acme.com]
template: customer-call
calendar_event_id: abc123
transcript: 2026-10-07-acme-sync.transcript.md
ai_ranges: [[12, 18], [24, 31]]
models: { enhance: claude-sonnet-5-5 }
---
`

describe('DocFrontmatter', () => {
  it('accepts the documented shape and keeps unknown keys', () => {
    const data = {
      id: '01JA2Z8Q4M7V3K9R5T1XWYB6CD',
      title: 'Q4',
      tags: ['a'],
      cssclasses: ['wide'],
    }
    expect(DocFrontmatter.parse(data)).toEqual(data)
  })

  it('requires an id', () => {
    expect(DocFrontmatter.safeParse({ title: 'x' }).success).toBe(false)
    expect(DocFrontmatter.safeParse({ id: '' }).success).toBe(false)
  })

  it('tolerates empty keys and a single tag written as a string', () => {
    const { data } = parseFrontmatter('---\nid: X\ntitle:\ntags: planning\n---\n')
    expect(DocFrontmatter.parse(data)).toEqual({ id: 'X', title: undefined, tags: ['planning'] })
  })

  it('rejects wrongly typed known keys', () => {
    expect(DocFrontmatter.safeParse({ id: 'X', tags: [1] }).success).toBe(false)
    expect(DocFrontmatter.safeParse({ id: 'X', title: 2 }).success).toBe(false)
  })
})

describe('MeetingFrontmatter', () => {
  it('accepts the meeting note from the Meetings PRD', () => {
    const parsed = MeetingFrontmatter.parse(parseFrontmatter(meeting).data)
    expect(parsed.ai_ranges).toEqual([
      [12, 18],
      [24, 31],
    ])
    expect(parsed.models).toEqual({ enhance: 'claude-sonnet-5-5' })
    expect(parsed.attendees).toHaveLength(2)
  })

  it('requires type: meeting, a title, and a date', () => {
    const base = { id: 'X', type: 'meeting', title: 'T', date: '2026-10-07' }
    expect(MeetingFrontmatter.safeParse(base).success).toBe(true)
    expect(MeetingFrontmatter.safeParse({ ...base, type: 'doc' }).success).toBe(false)
    expect(MeetingFrontmatter.safeParse({ ...base, title: undefined }).success).toBe(false)
    expect(MeetingFrontmatter.safeParse({ ...base, ai_ranges: [[1, 2, 3]] }).success).toBe(false)
  })
})

describe('SpaceConfig', () => {
  it('accepts a team space with or without an owner', () => {
    expect(SpaceConfig.safeParse({ name: 'team', schema: 1, kind: 'team' }).success).toBe(true)
    expect(
      SpaceConfig.safeParse({ name: 'team', schema: 1, kind: 'team', owner: 'a@b.com' }).success,
    ).toBe(true)
  })

  it('requires an owner for a personal space', () => {
    const result = SpaceConfig.safeParse({ name: 'dana', schema: 1, kind: 'personal' })
    expect(result.error?.issues).toEqual([expect.objectContaining({ path: ['owner'] })])
  })

  it('stores the owner as a lowercase email', () => {
    const config = { name: 'dana', schema: 1, kind: 'personal', owner: ' Dana@Example.test ' }
    expect(SpaceConfig.parse(config).owner).toBe('dana@example.test')
    expect(SpaceConfig.safeParse({ ...config, owner: 'dana' }).success).toBe(false)
  })

  it('rejects other schema versions and kinds', () => {
    expect(SpaceConfig.safeParse({ name: 'team', schema: 2, kind: 'team' }).success).toBe(false)
    expect(SpaceConfig.safeParse({ name: 'team', schema: 1, kind: 'shared' }).success).toBe(false)
    expect(SpaceConfig.safeParse({ name: 'team', schema: 1 }).success).toBe(false)
  })
})
