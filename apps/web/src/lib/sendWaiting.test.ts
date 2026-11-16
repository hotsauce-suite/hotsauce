import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'
import { PRIYA } from '../mocks/seed'
import { mockApi, server } from '../test/mockServer'
import { findDraft, saveDraft, strandedDrafts } from './drafts'
import { registerOpenDoc } from './openDoc'
import { sendWaitingDrafts } from './sendWaiting'

const SPACE = 'team'
const Q4 = 'docs/plans/q4-plan.md'
const ME = 'user-me'

function blob(path: string) {
  return mockApi().repo.read(SPACE, path)?.blobOid ?? ''
}

describe('sending saves that waited on this device (A4.4)', () => {
  it('sends a waiting save with its base version, merged forward', async () => {
    const before = mockApi().repo.read(SPACE, Q4)?.content ?? ''
    saveDraft(ME, SPACE, Q4, blob(Q4), `${before}\nOffline line.\n`, 'waiting')
    mockApi().repo.outsideEdit(SPACE, Q4, {
      author: PRIYA,
      apply: (c) => c.replace('# Q4 plan', '# Q4 plan (theirs)'),
    })
    const result = await sendWaitingDrafts(ME)
    expect(result).toEqual({ sent: 1, conflicts: [], failed: [] })
    const after = mockApi().repo.read(SPACE, Q4)?.content ?? ''
    expect(after).toContain('Offline line.')
    expect(after).toContain('(theirs)')
    expect(findDraft(SPACE, Q4, ME)).toBeNull()
  })

  it('a clash goes to the server’s conflict branch, and the member is told which doc', async () => {
    const before = mockApi().repo.read(SPACE, Q4)?.content ?? ''
    saveDraft(ME, SPACE, Q4, blob(Q4), before.replace('# Q4 plan', '# Q4 plan (mine)'), 'waiting')
    mockApi().repo.outsideEdit(SPACE, Q4, {
      author: PRIYA,
      apply: (c) => c.replace('# Q4 plan', '# Q4 plan (theirs)'),
    })
    expect(await sendWaitingDrafts(ME)).toEqual({ sent: 0, conflicts: [Q4], failed: [] })
    expect(findDraft(SPACE, Q4, ME)).toBeNull()
  })

  it('leaves ordinary drafts and the open doc alone', async () => {
    saveDraft(ME, SPACE, Q4, blob(Q4), 'not waiting')
    expect(await sendWaitingDrafts(ME)).toEqual({ sent: 0, conflicts: [], failed: [] })
    saveDraft(ME, SPACE, Q4, blob(Q4), 'open here', 'waiting')
    const off = registerOpenDoc(SPACE, Q4, async () => 'noop')
    expect(await sendWaitingDrafts(ME)).toEqual({ sent: 0, conflicts: [], failed: [] })
    off()
    expect(findDraft(SPACE, Q4, ME)?.content).toBe('open here')
  })

  it('never sends what another member left on this device', async () => {
    saveDraft('someone-else', SPACE, Q4, blob(Q4), 'theirs', 'waiting')
    expect(await sendWaitingDrafts(ME)).toEqual({ sent: 0, conflicts: [], failed: [] })
    expect(mockApi().repo.read(SPACE, Q4)?.content).not.toContain('theirs')
    expect(findDraft(SPACE, Q4, 'someone-else')?.content).toBe('theirs')
  })

  it('still offline: keeps it waiting', async () => {
    saveDraft(ME, SPACE, Q4, blob(Q4), 'later', 'waiting')
    server.use(http.put('/api/spaces/:space/file', () => HttpResponse.error()))
    expect(await sendWaitingDrafts(ME)).toEqual({ sent: 0, conflicts: [], failed: [] })
    expect(findDraft(SPACE, Q4, ME)).toMatchObject({ content: 'later', state: 'waiting' })
  })

  it('a doc deleted meanwhile keeps its text on this device, offered when it opens', async () => {
    saveDraft(ME, SPACE, Q4, blob(Q4), 'kept', 'waiting')
    server.use(
      http.put('/api/spaces/:space/file', () =>
        HttpResponse.json({ error: { code: 'not_found', message: 'Gone' } }, { status: 404 }),
      ),
    )
    const result = await sendWaitingDrafts(ME)
    expect(result.failed).toEqual([
      { space: SPACE, path: Q4, reason: 'it was moved, renamed or deleted' },
    ])
    expect(findDraft(SPACE, Q4, ME)).toMatchObject({ content: 'kept', state: 'stranded' })
    expect(strandedDrafts(ME).map((d) => d.path)).toEqual([Q4])
    // Not sent again, and not lost.
    expect((await sendWaitingDrafts(ME)).failed).toEqual([])
  })

  it('leaves a save another open tab is still typing into for that tab to send', async () => {
    const thisTab = sessionStorage.getItem('hotsauce.tab')
    sessionStorage.setItem('hotsauce.tab', 'tab-a')
    saveDraft(ME, SPACE, Q4, blob(Q4), 'tab A’s words', 'waiting')
    sessionStorage.setItem('hotsauce.tab', thisTab ?? 'tab-b')
    localStorage.setItem('hotsauce.tab-alive:tab-a', String(Date.now()))
    expect(await sendWaitingDrafts(ME)).toEqual({ sent: 0, conflicts: [], failed: [] })
    expect(findDraft(SPACE, Q4, ME)?.content).toBe('tab A’s words')
    // Tab A closed: this tab sends it.
    localStorage.removeItem('hotsauce.tab-alive:tab-a')
    expect(await sendWaitingDrafts(ME)).toEqual({ sent: 1, conflicts: [], failed: [] })
  })
})
