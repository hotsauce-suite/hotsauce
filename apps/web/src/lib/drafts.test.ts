import { describe, expect, it } from 'vitest'
import {
  clearDrafts,
  findDraft,
  removeDraft,
  saveDraft,
  strandedDrafts,
  waitingDrafts,
} from './drafts'

const A = 'user-a'
const B = 'user-b'
const DOC = 'docs/plan.md'

describe('drafts per member and per tab (docs/PLAN-offline.md, audit findings 3 and 4)', () => {
  it('another member saving or discarding leaves A’s waiting text alone', () => {
    saveDraft(A, 'team', DOC, 'blob1', 'A’s offline words', 'waiting')
    saveDraft(B, 'team', DOC, 'blob1', 'B typing')
    clearDrafts(B, 'team', DOC)
    expect(findDraft('team', DOC, A)).toMatchObject({
      content: 'A’s offline words',
      state: 'waiting',
    })
    expect(findDraft('team', DOC, B)).toBeNull()
    expect(waitingDrafts(B)).toEqual([])
    expect(waitingDrafts(A).map((d) => d.content)).toEqual(['A’s offline words'])
  })

  it('two tabs on the same doc never erase each other’s text', () => {
    saveDraft(A, 'team', DOC, 'blob1', 'from this tab', 'waiting')
    // Another tab: its own id in its own sessionStorage.
    const thisTab = sessionStorage.getItem('hotsauce.tab')
    sessionStorage.setItem('hotsauce.tab', 'othertab')
    saveDraft(A, 'team', DOC, 'blob1', 'from the other tab', 'waiting')
    clearDrafts(A, 'team', DOC)
    sessionStorage.setItem('hotsauce.tab', thisTab ?? '')
    expect(waitingDrafts(A).map((d) => d.content)).toEqual(['from this tab'])
  })

  it('a write the storage refuses keeps the last good copy and says so', () => {
    expect(saveDraft(A, 'team', DOC, 'blob1', 'good')).toBe(true)
    const real = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError')
    }
    try {
      expect(saveDraft(A, 'team', DOC, 'blob2', 'newer')).toBe(false)
    } finally {
      Storage.prototype.setItem = real
    }
    expect(findDraft('team', DOC, A)?.content).toBe('good')
  })

  it('reads drafts saved before drafts had owners, for anyone, until restored', () => {
    localStorage.setItem(
      'hearth.draft:team:docs/plan.md:oldblob',
      JSON.stringify({ content: 'from before', savedAt: 1 }),
    )
    const old = findDraft('team', DOC, A)
    expect(old).toMatchObject({
      content: 'from before',
      blobOid: 'oldblob',
      owner: null,
      state: 'editing',
    })
    // Never sent by itself: it was never marked waiting.
    expect(waitingDrafts(A)).toEqual([])
    removeDraft(old?.key ?? '')
    expect(findDraft('team', DOC, A)).toBeNull()
  })

  it('lists a member’s refused saves separately', () => {
    saveDraft(A, 'team', DOC, 'blob1', 'stuck', 'stranded')
    expect(strandedDrafts(A).map((d) => d.path)).toEqual([DOC])
    expect(strandedDrafts(B)).toEqual([])
    expect(waitingDrafts(A)).toEqual([])
  })
})
