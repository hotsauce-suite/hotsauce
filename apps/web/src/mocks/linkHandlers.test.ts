import { isId } from '@hotsauce/format'
import { describe, expect, it, vi } from 'vitest'
import { filesApi } from '../api/files'
import { linkKindLabel, linksApi, readProgress } from '../api/links'

// The live demo's Links (docs/PLAN-links-demo.md): the requirements R1-R5 are named per test.

const byTitle = async (title: string, view: 'unread' | 'archive' | 'all' = 'all') =>
  (await linksApi.list({ view })).links.find((l) => l.title.startsWith(title))

describe('mock links', () => {
  it('R1: lists saved links, newest first, with valid ids, in Unread and Archive', async () => {
    const unread = (await linksApi.list()).links
    expect(unread.length).toBeGreaterThanOrEqual(5)
    expect(unread.every((l) => !l.archived && isId(l.id))).toBe(true)
    const saved = unread.map((l) => l.saved)
    expect([...saved].sort().reverse()).toEqual(saved)
    const archive = (await linksApi.list({ view: 'archive' })).links
    expect(archive.length).toBeGreaterThanOrEqual(2)
    expect(archive.every((l) => l.archived)).toBe(true)
    const tags = await linksApi.tags()
    expect(tags.map((t) => t.name)).toContain('writing')
  })

  it('R2: shows reading progress: part read, read to the end, and not started', async () => {
    const labels = (await linksApi.list({ view: 'all' })).links.map((l) => readProgress(l.reading))
    expect(labels).toContain('Read')
    expect(labels.some((l) => /^\d+% read$/.test(l))).toBe(true)
    expect(labels).toContain('')
    const review = await byTitle('How to run a weekly review')
    if (!review) throw new Error('missing')
    await linksApi.setReading(review.space, review.id, { anchor: 7, percent: 80 })
    expect(readProgress((await byTitle('How to run a weekly review'))?.reading ?? null)).toBe(
      '80% read',
    )
  })

  it('R3: has highlights with notes from teammates, found in the copy, and copies them to a doc', async () => {
    const review = await byTitle('How to run a weekly review')
    if (!review) throw new Error('missing')
    const full = await linksApi.get(review.space, review.id)
    expect(full.highlights.length).toBeGreaterThanOrEqual(2)
    for (const h of full.highlights) expect(full.body).toContain(h.quote)
    expect(new Set(full.highlights.map((h) => h.name)).size).toBeGreaterThan(1)
    expect(full.highlights.some((h) => h.note)).toBe(true)
    const { highlights } = await linksApi.highlights()
    expect(highlights.length).toBeGreaterThanOrEqual(4)
    const doc = await linksApi.copyHighlights(review.space, review.id)
    expect(doc.title).toBe(`Highlights: ${review.title}`)
    expect(doc.space).toBe('ada')
  })

  it('R4: has an arXiv paper with its PDF in Files, a bioRxiv paper, and an added PDF', async () => {
    const all = (await linksApi.list({ view: 'all' })).links
    const kinds = all.map(linkKindLabel)
    expect(kinds).toEqual(expect.arrayContaining(['arXiv', 'bioRxiv', 'PDF']))
    const arxiv = all.find((l) => l.paper?.server === 'arxiv')
    expect(arxiv?.file).toBeTruthy()
    expect(arxiv?.paper?.authors.length).toBeGreaterThan(3)
    const pdf = await filesApi.get(arxiv?.space ?? '', arxiv?.file ?? '')
    expect(pdf.name).toMatch(/\.pdf$/)
    expect(pdf.folder).toBe('Links')
  })

  it('R5: saves a new link and reads it after a short fetch; a waiting link gets its page', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const saved = await linksApi.save({ url: 'https://news.example/story', source: 'web' })
      expect(saved.status).toBe('fetching')
      await vi.advanceTimersByTimeAsync(1500)
      const read = await linksApi.get(saved.space, saved.id)
      expect(read.status).toBe('ready')
      expect(read.body).toContain('https://news.example/story')

      const waiting = (await linksApi.list()).links.find((l) => l.status === 'waiting')
      if (!waiting) throw new Error('missing')
      await linksApi.refetch(waiting.space, waiting.id)
      await vi.advanceTimersByTimeAsync(1500)
      const fetched = await linksApi.get(waiting.space, waiting.id)
      expect(fetched.status).toBe('ready')
      expect(fetched.body.length).toBeGreaterThan(200)
    } finally {
      vi.useRealTimers()
    }
  })
})
