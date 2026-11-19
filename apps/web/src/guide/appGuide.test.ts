// Hotsauce 101's content (docs/PLAN-tour-and-101.md H1-H3).
import { describe, expect, it } from 'vitest'
import { APPS } from '../apps/registry'
import { GUIDE, posterOf, sortedForWorkspace, statusOf, videoOf } from './appGuide'
import { GUIDE_NAMES } from './guideNames'

describe('the guide', () => {
  it('gives Command-K the same apps and names (H5)', () => {
    expect(GUIDE_NAMES).toEqual(GUIDE.map((e) => ({ id: e.id, name: e.name })))
  })

  it('has a card for every app in the suite (H1)', () => {
    const covered = new Set(GUIDE.map((e) => e.app))
    for (const app of APPS) expect(covered, `no card for ${app.id}`).toContain(app.id)
  })

  it('gives every card its words, a picture and a video (H2)', () => {
    for (const entry of GUIDE) {
      expect(entry.name, entry.id).not.toBe('')
      expect(entry.line, entry.id).not.toBe('')
      expect(entry.feats.length, entry.id).toBeGreaterThan(0)
      expect(videoOf(entry), `${entry.id} video`).not.toBeNull()
      expect(posterOf(entry), `${entry.id} picture`).not.toBeNull()
    }
  })

  it('says what a card still needs, and puts ready ones first (H3)', () => {
    const meetings = GUIDE.find((e) => e.id === 'meeting')
    if (!meetings) throw new Error('no Meetings card')
    expect(statusOf(meetings, { ai: true, transcription: true })).toEqual({
      ready: true,
      missing: null,
    })
    expect(statusOf(meetings, { ai: false, transcription: false }).missing).toBe(
      'a speech-to-text key and an AI key',
    )
    expect(statusOf(meetings, undefined).ready).toBe(true)
    const sorted = sortedForWorkspace(GUIDE, { ai: false, transcription: true })
    const firstNotReady = sorted.findIndex((e) => !statusOf(e, { ai: false }).ready)
    expect(sorted.slice(firstNotReady).every((e) => e.requires.includes('ai'))).toBe(true)
    expect(sorted[0]?.id).toBe('today')
  })
})
