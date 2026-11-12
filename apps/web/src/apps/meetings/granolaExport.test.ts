import { describe, expect, it } from 'vitest'
import { makeZip } from '../../test/zip'
import {
  attendeesOf,
  batches,
  granolaColumns,
  parseCsv,
  parseGranolaCsv,
  readGranolaExport,
} from './granolaExport'

const CSV = [
  '﻿document_id,document_title,document_created,notes,summary,transcript,user_email',
  'd1,Acme kickoff,2026-03-04T15:30:00-05:00,"Dana wants SSO\r\n- pricing","- Ship ""SSO"" first","Me: Hi\nThem: Hello, all",a@x.test',
  ',No id,2026-03-05T10:00:00Z,,summary only,,a@x.test',
  '',
].join('\r\n')

describe('parseCsv', () => {
  it('reads quoted fields with commas, quotes and line breaks, and drops a BOM', () => {
    const rows = parseCsv(CSV)
    expect(rows).toHaveLength(3)
    expect(rows[0]?.[0]).toBe('document_id')
    expect(rows[1]?.[3]).toBe('Dana wants SSO\r\n- pricing')
    expect(rows[1]?.[4]).toBe('- Ship "SSO" first')
    expect(rows[1]?.[5]).toBe('Me: Hi\nThem: Hello, all')
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
})

describe('granolaColumns', () => {
  it('finds columns by name, whatever the export calls them', () => {
    expect(granolaColumns(['Title', 'Created At', 'Summary', 'Transcript'])).toEqual({
      title: 0,
      date: 1,
      summary: 2,
      transcript: 3,
    })
    expect(granolaColumns(['name', 'email'])).toBeNull()
  })
})

describe('parseGranolaCsv', () => {
  it('maps rows to meetings, with a stable ref when there is no id', async () => {
    const meetings = await parseGranolaCsv(CSV)
    expect(meetings[0]).toEqual({
      ref: 'g:d1',
      title: 'Acme kickoff',
      date: '2026-03-04T15:30:00-05:00',
      notes: 'Dana wants SSO\r\n- pricing',
      summary: '- Ship "SSO" first',
      transcript: 'Me: Hi\nThem: Hello, all',
    })
    expect(meetings[1]?.ref).toMatch(/^h:[0-9a-f]{32}$/)
    expect((await parseGranolaCsv(CSV))[1]?.ref).toBe(meetings[1]?.ref)
    expect(await parseGranolaCsv('name,email\nx,y')).toEqual([])
  })

  it('splits attendees on ; and lines, and on commas only between addresses', async () => {
    const m = await parseGranolaCsv(
      'title,date,summary,attendees\nT,2026-01-01,s,"Shah, Priya; Sam\nDana Lee <dana@a.com>, b@a.com"',
    )
    expect(m[0]?.attendees).toEqual(['Shah, Priya', 'Sam', 'Dana Lee <dana@a.com>', 'b@a.com'])
    expect(attendeesOf('a@x.com, b@x.com')).toEqual(['a@x.com', 'b@x.com'])
  })
})

describe('readGranolaExport', () => {
  it('reads .csv files and CSVs inside a .zip, once each meeting', async () => {
    const zip = makeZip([
      { name: 'granola/notes.csv', text: CSV, deflate: true },
      { name: '__MACOSX/granola/._notes.csv', text: 'junk' },
      { name: 'readme.txt', text: 'hi' },
    ])
    const files = [
      new File([zip], 'export.zip', { type: 'application/zip' }),
      new File([CSV], 'notes.csv', { type: 'text/csv' }),
    ]
    const meetings = await readGranolaExport(files)
    expect(meetings.map((m) => m.title)).toEqual(['Acme kickoff', 'No id'])
  })
})

describe('batches', () => {
  it('splits by count and by size', () => {
    const m = (n: number) => ({
      ref: `r${n}`,
      title: 't',
      date: 'd',
      notes: '',
      summary: '',
      transcript: 'x'.repeat(100),
    })
    const all = Array.from({ length: 5 }, (_, i) => m(i))
    expect(batches(all, 2).map((b) => b.length)).toEqual([2, 2, 1])
    expect(batches(all, 100, 400).map((b) => b.length)).toEqual([2, 2, 1])
  })

  it('measures size in UTF-8 bytes, not characters', () => {
    const wide = (n: number) => ({
      ref: `r${n}`,
      title: 't',
      date: 'd',
      notes: '',
      summary: '',
      transcript: '会'.repeat(100),
    })
    // 100 characters, 300 bytes each: two don't fit in 500 bytes.
    expect(batches([wide(1), wide(2)], 100, 500).map((b) => b.length)).toEqual([1, 1])
  })
})
