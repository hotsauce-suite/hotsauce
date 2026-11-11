import { setupWorker } from 'msw/browser'
import { createMockApi } from './handlers'
import { PRIYA } from './seed'

/**
 * Dev-only (`VITE_MOCK_API=1`): the whole API runs in the page against an in-memory repo.
 * `window.hearthMock.outsideEdit(space, path, find, replace)` simulates a teammate's push.
 */
export async function startMockApi(): Promise<void> {
  const mock = createMockApi({ latencyMs: 90 })
  const worker = setupWorker(...mock.handlers)
  await worker.start({ onUnhandledFrame: 'bypass', quiet: true })

  const outsideEdit = (space: string, path: string, find: string, replace: string) => {
    const commit = mock.repo.outsideEdit(space, path, {
      author: PRIYA,
      apply: (content) => content.replace(find, replace),
    })
    if (commit) mock.broadcast({ type: 'changed', space, headOid: commit.oid, paths: [path] })
    return commit?.oid ?? null
  }
  Object.assign(window, {
    hearthMock: {
      repo: mock.repo,
      meetings: mock.meetings,
      outsideEdit,
      dropMeetingSockets: mock.dropMeetingSockets,
    },
  })
}
