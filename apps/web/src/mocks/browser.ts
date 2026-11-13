import { HttpResponse, http } from 'msw'
import { setupWorker } from 'msw/browser'
import { createMockApi } from './handlers'
import { PRIYA } from './seed'

/**
 * Dev-only (`VITE_MOCK_API=1`): the whole API runs in the page against an in-memory repo.
 * `window.hearthMock.outsideEdit(space, path, find, replace)` simulates a teammate's push.
 */
export async function startMockApi(): Promise<void> {
  const mock = createMockApi({ latencyMs: 90 })
  // In the static demo there is no server behind the mock: answer anything it doesn't cover
  // here instead of letting the request reach the network.
  const fallback =
    import.meta.env.MODE === 'demo'
      ? [
          http.all('/api/*', () =>
            HttpResponse.json(
              { error: { code: 'demo', message: 'This part of the app isn’t in the demo yet' } },
              { status: 404 },
            ),
          ),
        ]
      : []
  const worker = setupWorker(...mock.handlers, ...fallback)
  await worker.start({
    onUnhandledFrame: 'bypass',
    quiet: true,
    serviceWorker: { url: '/mockServiceWorker.js' },
  })

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
