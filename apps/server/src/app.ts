import { Hono } from 'hono'
import {
  type AppDeps,
  type AppEnv,
  accountRoutes,
  adminOrgRoutes,
  assetRoutes,
  authenticate,
  authorizeSpace,
  calendarRoutes,
  clipRoutes,
  conflictRoutes,
  dictationRoutes,
  fileRoutes,
  handleError,
  historyRoutes,
  limitBody,
  meetingRoutes,
  orgPublicRoutes,
  publicRoutes,
  searchRoutes,
  setupRoutes,
  testRoutes,
  tokenRoutes,
} from './api/index.js'
import { HearthError } from './errors.js'
import { mcpRoutes } from './mcp/index.js'

/**
 * The HTTP API (ARCHITECTURE §3.8), built from injected services. main.ts adds /ws and the web
 * app around it; tests call `app.request()` on it directly.
 */
export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>()
  const routes = app
    .use('/api/*', authenticate(deps))
    .use('/api/*', limitBody())
    .use('/api/spaces/:space/*', authorizeSpace(deps))
    .route('/api', publicRoutes(deps))
    .route('/api', orgPublicRoutes(deps))
    .route('/api', setupRoutes(deps))
    .route('/api', adminOrgRoutes(deps))
    .route('/api', accountRoutes(deps))
    .route('/api', searchRoutes(deps))
    .route('/api', fileRoutes(deps))
    .route('/api', historyRoutes(deps))
    .route('/api', conflictRoutes(deps))
    .route('/api', assetRoutes(deps))
    .route('/api', meetingRoutes(deps))
    .route('/api', calendarRoutes(deps))
    .route('/api', tokenRoutes(deps))
    .route('/api', dictationRoutes(deps))
    .route('/api', clipRoutes(deps))
  // e2e hooks (ARCHITECTURE §7.8); never mounted outside NODE_ENV=test.
  if (deps.config.NODE_ENV === 'test') app.route('/api', testRoutes(deps))
  // The MCP endpoint for agents (ARCHITECTURE §8.2): same authentication and body limit as /api.
  app.use('/mcp', authenticate(deps)).use('/mcp', limitBody()).route('/mcp', mcpRoutes(deps))
  // Unknown API paths get a JSON 404, never the web app's index.html.
  app.all('/api/*', () => {
    throw new HearthError('not_found', 'No such API route')
  })
  app.onError(handleError)
  return routes
}

/** The API's type, for the web client's `hc<AppType>()`. */
export type AppType = ReturnType<typeof createApp>
