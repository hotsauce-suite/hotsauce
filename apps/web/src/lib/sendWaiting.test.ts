import { HttpResponse, http } from 'msw'
import { describe, expect, it } from 'vitest'
import { PRIYA } from '../mocks/seed'
import { mockApi, server } from '../test/mockServer'
import { findDraft, saveDraft } from './drafts'
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
    saveDraft(SPACE, Q4, blob(Q4), `${before}\nOffline line.\n`, { waiting: true, owner: ME })
    mockApi().repo.outsideEdit(SPACE, Q4, {
      author: PRIYA,
      apply: (c) => c.replace('# Q4 plan', '# Q4 plan (theirs)'),
    })
    const result = await sendWaitingDrafts(ME)
    expect(result).toEqual({ sent: 1, conflicts: [] })
    const after = mockApi().repo.read(SPACE, Q4)?.content ?? ''
    expect(after).toContain('Offline line.')
    expect(after).toContain('(theirs)')
    expect(findDraft(SPACE, Q4)).toBeNull()
  })

  it('a clash goes to the server’s conflict branch, and the member is told which doc', async () => {
    const before = mockApi().repo.read(SPACE, Q4)?.content ?? ''
    saveDraft(SPACE, Q4, blob(Q4), before.replace('# Q4 plan', '# Q4 plan (mine)'), {
      waiting: true,
      owner: ME,
    })
    mockApi().repo.outsideEdit(SPACE, Q4, {
      author: PRIYA,
      apply: (c) => c.replace('# Q4 plan', '# Q4 plan (theirs)'),
    })
    expect(await sendWaitingDrafts(ME)).toEqual({ sent: 0, conflicts: [Q4] })
    expect(findDraft(SPACE, Q4)).toBeNull()
  })

  it('leaves ordinary drafts and the open doc alone', async () => {
    saveDraft(SPACE, Q4, blob(Q4), 'not waiting')
    expect(await sendWaitingDrafts(ME)).toEqual({ sent: 0, conflicts: [] })
    saveDraft(SPACE, Q4, blob(Q4), 'open here', { waiting: true, owner: ME })
    const off = registerOpenDoc(SPACE, Q4, async () => 'noop')
    expect(await sendWaitingDrafts(ME)).toEqual({ sent: 0, conflicts: [] })
    off()
    expect(findDraft(SPACE, Q4)?.content).toBe('open here')
  })

  it('never sends what another member left on this device', async () => {
    saveDraft(SPACE, Q4, blob(Q4), 'theirs', { waiting: true, owner: 'someone-else' })
    expect(await sendWaitingDrafts(ME)).toEqual({ sent: 0, conflicts: [] })
    expect(mockApi().repo.read(SPACE, Q4)?.content).not.toContain('theirs')
    expect(findDraft(SPACE, Q4)?.content).toBe('theirs')
  })

  it('still offline: keeps it waiting', async () => {
    saveDraft(SPACE, Q4, blob(Q4), 'later', { waiting: true, owner: ME })
    server.use(http.put('/api/spaces/:space/file', () => HttpResponse.error()))
    expect(await sendWaitingDrafts(ME)).toEqual({ sent: 0, conflicts: [] })
    expect(findDraft(SPACE, Q4)).toMatchObject({ content: 'later', waiting: true })
  })

  it('a doc deleted meanwhile keeps its text on this device, offered when it opens', async () => {
    saveDraft(SPACE, Q4, blob(Q4), 'kept', { waiting: true, owner: ME })
    server.use(
      http.put('/api/spaces/:space/file', () =>
        HttpResponse.json({ error: { code: 'not_found', message: 'Gone' } }, { status: 404 }),
      ),
    )
    await sendWaitingDrafts(ME)
    expect(findDraft(SPACE, Q4)).toMatchObject({ content: 'kept', waiting: false })
  })
})
