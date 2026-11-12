import { setupServer } from 'msw/node'
import { createMockApi, type MockApi } from '../mocks/handlers'

export const TEST_USER = 'ada@example.test'

export const server = setupServer()

let current: MockApi | null = null

/** A freshly seeded fake repo per test, so tests never see each other's writes. */
export function resetMockApi(): MockApi {
  current = createMockApi()
  server.resetHandlers(...current.handlers)
  return current
}

export function mockApi(): MockApi {
  if (!current) throw new Error('mock API not started; is src/test/setup.ts loaded?')
  return current
}
