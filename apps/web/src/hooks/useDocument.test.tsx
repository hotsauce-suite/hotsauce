import { newDoc, parseFrontmatter } from '@hearth/format'
import { act, renderHook, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { api } from '../api/client'
import type { ServerEvent } from '../api/types'
import { hearthSocket } from '../api/ws'
import type { EditorBridge } from '../components/MarkdownEditor'
import { draftKey, saveDraft } from '../lib/drafts'
import { PRIYA } from '../mocks/seed'
import { mockApi, server } from '../test/mockServer'
import { GONE_WHILE_EDITING, type SaveState, useDocument } from './useDocument'

const SPACE = 'team'
const Q4 = 'docs/plans/q4-plan.md'
const RITUALS = 'docs/team-rituals.md'

/** Renders the hook and records every save state it passes through. */
function renderDocument(
  path: string,
  opts: { idleCommitMs?: number; isNew?: boolean; newDocText?: string } = {},
) {
  const states: SaveState[] = []
  const hook = renderHook(() => {
    const doc = useDocument(SPACE, path, { idleCommitMs: opts.idleCommitMs ?? 20, ...opts })
    if (states.at(-1) !== doc.state.saveState) states.push(doc.state.saveState)
    return doc
  })
  return { ...hook, states }
}

/** A stand-in for the editor: holds text and records what the hook pushed into it. */
function fakeEditor() {
  let text = ''
  const bridge: EditorBridge & { adopted: string[] } = {
    adopted: [],
    revealFrontmatter: () => {},
    revealLine: () => {},
    selection: () => ({ anchor: 0, head: 0 }),
    cursorOnHeading: () => false,
    freeze: () => {},
    getText: () => text,
    setText: (next) => {
      text = next
      bridge.adopted.push(next)
    },
  }
  return bridge
}

async function loaded(result: { current: ReturnType<typeof useDocument> }) {
  await waitFor(() => expect(result.current.state.status).toBe('ready'))
}

/**
 * Restores the real API and commits, so the hook unmounts clean. A dirty hook flushes on
 * unmount, and that late PUT would otherwise land in the next test's fresh repo.
 */
async function settle(result: { current: ReturnType<typeof useDocument> }) {
  server.resetHandlers(...mockApi().handlers)
  await act(() => result.current.commit())
  expect(result.current.isDirty()).toBe(false)
}

/** Socket events only flow after the auth handshake, so keep broadcasting until one lands. */
async function broadcastUntil(event: ServerEvent, check: () => void) {
  await vi.waitFor(() => {
    mockApi().broadcast(event)
    check()
  })
}

describe('useDocument', () => {
  it('stops retrying and says so when the doc was moved or deleted elsewhere', async () => {
    const { result } = renderDocument(Q4)
    await loaded(result)
    let puts = 0
    server.use(
      http.put('/api/spaces/team/file', () => {
        puts++
        return HttpResponse.json(
          { error: { code: 'not_found', message: 'docs/plans/q4-plan.md was moved or deleted' } },
          { status: 404 },
        )
      }),
    )
    act(() => result.current.edit(`${result.current.getText()}\nTyped before it moved.\n`))
    await waitFor(() => expect(result.current.state.saveError).toBe(GONE_WHILE_EDITING))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(puts).toBe(1)
    expect(result.current.getText()).toContain('Typed before it moved.')
    await settle(result)
  })

  it('loads the file and starts clean', async () => {
    const { result } = renderDocument(Q4)
    await loaded(result)
    expect(result.current.state.saveState).toBe('committed')
    expect(result.current.state.initialText).toContain('# Q4 plan')
    expect(result.current.getText()).toBe(result.current.state.initialText)
  })

  it('goes dirty → saving → committed after the idle delay', async () => {
    const { result, states } = renderDocument(Q4)
    await loaded(result)
    const edited = `${result.current.getText()}\nOne more line.\n`
    act(() => result.current.edit(edited))
    expect(result.current.state.saveState).toBe('dirty')
    await waitFor(() => expect(result.current.state.saveState).toBe('committed'))
    expect(states).toEqual(['committed', 'dirty', 'saving', 'committed'])
    expect(mockApi().repo.read(SPACE, Q4)?.content).toBe(edited)
    expect(mockApi().repo.history(SPACE, Q4)[0]?.author.email).toBe('ada@example.test')
  })

  it('does not commit while the user keeps typing', async () => {
    const { result } = renderDocument(Q4, { idleCommitMs: 200 })
    await loaded(result)
    const put = vi.spyOn(api, 'putFile')
    for (let i = 0; i < 5; i++) {
      act(() => result.current.edit(`${result.current.getText()}x`))
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(put).not.toHaveBeenCalled()
    await waitFor(() => expect(put).toHaveBeenCalledOnce(), { timeout: 1000 })
    await waitFor(() => expect(result.current.state.saveState).toBe('committed'))
  })

  it('adopts the merged text when the server merged a concurrent edit', async () => {
    const { result } = renderDocument(RITUALS)
    await loaded(result)
    const editor = fakeEditor()
    act(() => result.current.bindEditor(editor))
    // A teammate's edit to the standup line (armed in the seed) lands before ours.
    act(() => result.current.edit(result.current.getText().replace('first week', 'second week')))
    await waitFor(() => expect(result.current.state.saveState).toBe('committed'))
    expect(result.current.getText()).toContain('second week')
    expect(result.current.getText()).toContain('Standup is at 9:45')
    expect(editor.adopted.at(-1)).toBe(result.current.getText())
  })

  it('opens the resolver on a 409 and keeps both versions', async () => {
    const { result } = renderDocument(RITUALS)
    await loaded(result)
    const mine = result.current.getText().replace('Standup is at 9:30', 'Standup is at 10:00')
    act(() => result.current.edit(mine))
    await waitFor(() => expect(result.current.state.saveState).toBe('conflict'))
    const conflict = result.current.state.conflict
    expect(conflict?.ref).toMatch(/^refs\/heads\/conflicts\//)
    expect(conflict?.ours).toBe(mine)
    expect(conflict?.theirs).toContain('Standup is at 9:45')
    // Nothing of ours reached main.
    expect(mockApi().repo.read(SPACE, RITUALS)?.content).not.toContain('10:00')
  })

  it('resolving a conflict commits the chosen text and clears it', async () => {
    const { result } = renderDocument(RITUALS)
    await loaded(result)
    act(() => result.current.edit(result.current.getText().replace('9:30', '10:00')))
    await waitFor(() => expect(result.current.state.conflict).not.toBeNull())
    const resolved = result.current.state.conflict?.theirs.replace('9:45', '9:50') ?? ''
    await act(() => result.current.resolveConflict(resolved))
    expect(result.current.state.conflict).toBeNull()
    expect(result.current.state.saveState).toBe('committed')
    // The server committed our resolution (adding its frontmatter id) and we adopted that text.
    const onMain = mockApi().repo.read(SPACE, RITUALS)?.content ?? ''
    expect(onMain).toContain('Standup is at 9:50')
    expect(result.current.getText()).toBe(onMain)
    expect(
      mockApi()
        .repo.listConflicts(SPACE)
        .some((c) => c.path === RITUALS),
    ).toBe(false)
  })

  it('refetches on a socket change when there are no local edits', async () => {
    hearthSocket.start()
    const { result } = renderDocument(Q4)
    await loaded(result)
    const commit = mockApi().repo.outsideEdit(SPACE, Q4, {
      author: PRIYA,
      apply: (c) => c.replace('## Budget', '## Budget and spend'),
    })
    await broadcastUntil(
      { type: 'changed', space: SPACE, headOid: commit?.oid ?? '', paths: [Q4] },
      () => expect(result.current.getText()).toContain('## Budget and spend'),
    )
    expect(result.current.state.saveState).toBe('committed')
  })

  it('does not clobber local edits on a socket change; the next save merges', async () => {
    hearthSocket.start()
    const { result } = renderDocument(Q4, { idleCommitMs: 60_000 })
    await loaded(result)
    const mine = result.current.getText().replace('# Q4 plan', '# Q4 plan (draft)')
    act(() => result.current.edit(mine))
    const commit = mockApi().repo.outsideEdit(SPACE, Q4, {
      author: PRIYA,
      apply: (c) => c.replace('## Budget', '## Budget and spend'),
    })
    const event: ServerEvent = {
      type: 'changed',
      space: SPACE,
      headOid: commit?.oid ?? '',
      paths: [Q4],
    }
    const read = vi.spyOn(api, 'readFile')
    const delivered = vi.fn()
    hearthSocket.onChanged(delivered)
    await broadcastUntil(event, () => expect(delivered).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 50))
    expect(read).not.toHaveBeenCalled()
    expect(result.current.getText()).toBe(mine)
    expect(result.current.state.saveState).toBe('dirty')

    await act(() => result.current.commit())
    expect(result.current.getText()).toContain('# Q4 plan (draft)')
    expect(result.current.getText()).toContain('## Budget and spend')
  })

  it('keeps the draft in localStorage and offers it on reload', async () => {
    const first = renderDocument(Q4, { idleCommitMs: 60_000 })
    await loaded(first.result)
    const blob = mockApi().repo.read(SPACE, Q4)?.blobOid ?? ''
    act(() => first.result.current.edit('# Q4 plan\n\nUnsaved thought.\n'))
    await waitFor(() => expect(localStorage.getItem(draftKey(SPACE, Q4, blob))).not.toBeNull())
    // Simulate a crash: drop the hook without its unmount flush reaching the server.
    server.use(http.put('/api/spaces/:space/file', () => HttpResponse.error()))
    first.unmount()

    const second = renderDocument(Q4)
    await loaded(second.result)
    expect(second.result.current.state.draft?.content).toBe('# Q4 plan\n\nUnsaved thought.\n')
    act(() => second.result.current.restoreDraft())
    expect(second.result.current.getText()).toBe('# Q4 plan\n\nUnsaved thought.\n')
    expect(second.result.current.state.saveState).toBe('dirty')
    await settle(second.result)
  })

  it('restoring a draft from an older version merges it forward on save', async () => {
    const before = await api.readFile(SPACE, Q4)
    const draft = before.content.replace('- Ship Hearth Docs', '- Ship Hearth Docs (all of it)')
    saveDraft(SPACE, Q4, before.blobOid, draft)
    mockApi().repo.outsideEdit(SPACE, Q4, {
      author: PRIYA,
      apply: (c) => c.replace('- Reagent lead times', '- Supplier lead times'),
    })
    const { result } = renderDocument(Q4, { idleCommitMs: 60_000 })
    await loaded(result)
    expect(result.current.state.draft).not.toBeNull()
    act(() => result.current.restoreDraft())
    await act(() => result.current.commit())
    expect(result.current.state.saveState).toBe('committed')
    expect(result.current.getText()).toContain('(all of it)')
    expect(result.current.getText()).toContain('Supplier lead times')
  })

  it('shows "saved" (kept on this device) when the save fails, and keeps the draft', async () => {
    server.use(http.put('/api/spaces/:space/file', () => HttpResponse.error()))
    const { result } = renderDocument(Q4)
    await loaded(result)
    act(() => result.current.edit('# Q4 plan\n\nOffline edit.\n'))
    await waitFor(() => expect(result.current.state.saveState).toBe('saved'))
    expect(result.current.state.saveError).toMatch(/reach/)
    const blob = mockApi().repo.read(SPACE, Q4)?.blobOid ?? ''
    expect(localStorage.getItem(draftKey(SPACE, Q4, blob))).toContain('Offline edit.')
    await settle(result)
  })

  it('a new doc is not created until the first save, then exactly one commit', async () => {
    const path = 'docs/untitled.md'
    const { result } = renderDocument(path, { isNew: true, newDocText: '# Untitled\n\n' })
    await loaded(result)
    expect(result.current.state.isNew).toBe(true)
    await act(() => result.current.commit())
    expect(mockApi().repo.read(SPACE, path)).toBeNull()

    const editor = fakeEditor()
    act(() => result.current.bindEditor(editor))
    act(() => result.current.edit('# Untitled\n\nHello.\n'))
    await waitFor(() => expect(result.current.state.saveState).toBe('committed'))
    expect(mockApi().repo.history(SPACE, path)).toHaveLength(1)
    expect(result.current.state.isNew).toBe(false)
    // `committed` came back with the server's text (an id added): the editor adopts it, and
    // it becomes the base for the next save, so nothing is dirty.
    const onMain = mockApi().repo.read(SPACE, path)?.content ?? ''
    expect(onMain).toMatch(/^---\nid: \w+\n---\n# Untitled\n\nHello\.\n$/)
    expect(editor.adopted.at(-1)).toBe(onMain)
    expect(result.current.isDirty()).toBe(false)
  })

  it('a new doc can be created under another name, never over an existing file', async () => {
    const { result } = renderDocument('docs/untitled.md', {
      isNew: true,
      newDocText: '# Untitled\n\n',
    })
    await loaded(result)
    act(() => result.current.bindEditor(fakeEditor()))
    act(() => result.current.edit('# Q4 plan\n\nHello.\n'))
    // Taken: nothing is written, and the doc stays new and unsaved.
    expect(await act(() => result.current.createAt(Q4))).toBe('taken')
    expect(mockApi().repo.read(SPACE, Q4)?.content).not.toContain('Hello.')
    expect(result.current.state.isNew).toBe(true)
    // Free: created there, and the untitled path never enters Git.
    expect(await act(() => result.current.createAt('docs/q4-plan-2.md'))).toBe('committed')
    expect(mockApi().repo.read(SPACE, 'docs/q4-plan-2.md')?.content).toContain('Hello.')
    expect(mockApi().repo.read(SPACE, 'docs/untitled.md')).toBeNull()
    // Once saved, it's no longer new: the caller moves it instead.
    expect(await act(() => result.current.createAt('docs/other.md'))).toBe('not-new')
  })

  it('a new doc from newDoc() commits with its id, and its title follows the typed heading', async () => {
    const path = 'docs/untitled-2.md'
    const { text: template } = newDoc('Untitled')
    const { result } = renderDocument(path, { isNew: true, newDocText: template })
    await loaded(result)
    const editor = fakeEditor()
    act(() => result.current.bindEditor(editor))

    act(() => result.current.edit(`${template.replace('# Untitled', '# Kiln log')}Fired.\n`))
    await waitFor(() => expect(result.current.state.saveState).toBe('committed'))

    const onMain = mockApi().repo.read(SPACE, path)?.content ?? ''
    expect(parseFrontmatter(onMain).data).toMatchObject({
      id: parseFrontmatter(template).data.id,
      title: 'Kiln log',
    })
    expect(onMain).toContain('# Kiln log\n\nFired.\n')
    expect(editor.adopted.at(-1)).toBe(onMain)
    expect(mockApi().repo.history(SPACE, path)[0]?.message).toBe('docs: create "Kiln log"')
    expect(result.current.isDirty()).toBe(false)
  })

  it('replays edits made during a save onto text the server changed', async () => {
    const { result } = renderDocument('docs/eng/onboarding.md', { idleCommitMs: 60_000 })
    await loaded(result)
    const sent = `${result.current.getText()}- [ ] Meet the team\n`
    act(() => result.current.edit(sent))
    let saving: Promise<unknown> = Promise.resolve()
    act(() => {
      saving = result.current.commit()
    })
    // Typed while the PUT is in flight; the server meanwhile adds a frontmatter id at the top.
    act(() => result.current.edit(`${sent}- [ ] Book a desk\n`))
    await act(() => saving)
    const text = result.current.getText()
    expect(text).toMatch(/^---\nid: \w+\n---\n# Onboarding/)
    expect(text).toContain('- [ ] Meet the team\n- [ ] Book a desk\n')
    expect(result.current.state.saveState).toBe('dirty')
    await settle(result)
  })

  it('Save version sends the label', async () => {
    const { result } = renderDocument(Q4, { idleCommitMs: 60_000 })
    await loaded(result)
    act(() => result.current.edit(`${result.current.getText()}\nFinal.\n`))
    await act(() => result.current.commit({ label: 'Sent to board' }))
    expect(mockApi().repo.history(SPACE, Q4)[0]?.label).toBe('Sent to board')
  })

  it('"Decide later" parks a server conflict: nothing pending, so leaving does not re-commit', async () => {
    const { result } = renderDocument(RITUALS)
    await loaded(result)
    act(() => result.current.edit(result.current.getText().replace('9:30', '10:00')))
    await waitFor(() => expect(result.current.state.conflict).not.toBeNull())
    const ref = result.current.state.conflict?.ref
    act(() => result.current.dismissConflict())
    expect(result.current.state.conflict).toBeNull()
    expect(result.current.state.serverConflicts.map((c) => c.ref)).toEqual([ref])
    expect(result.current.state.saveState).toBe('conflict')
    expect(result.current.isDirty()).toBe(false)
    expect(
      mockApi()
        .repo.listConflicts(SPACE)
        .filter((c) => c.path === RITUALS),
    ).toHaveLength(1)
  })

  it('lists an existing server conflict for the open path and opens it on request', async () => {
    const { result } = renderDocument('docs/plans/hiring.md')
    await loaded(result)
    await waitFor(() => expect(result.current.state.serverConflicts).toHaveLength(1))
    const ref = result.current.state.serverConflicts[0]?.ref ?? ''
    await act(() => result.current.openConflict(ref))
    expect(result.current.state.conflict?.ours).toContain('Three interviews')
    expect(result.current.state.saveState).toBe('conflict')
  })
})
