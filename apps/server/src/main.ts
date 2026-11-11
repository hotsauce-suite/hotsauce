import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { type Context, Hono } from 'hono'
import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { OrgStore } from './org/store.js'
import { createServices, loadEnvFile } from './services.js'
import { rebuildRegistryFromClones } from './spaces/index.js'
import { attachWebSocket, Poller } from './sync/index.js'

// apps/server/{src,dist}/main.{ts,js} → apps/web/dist, whatever the working directory.
const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url))

async function main(): Promise<void> {
  loadEnvFile()
  // The organization's saved settings sit under the real environment, which always wins.
  const org = new OrgStore({
    dataDir: path.resolve(process.env.DATA_DIR ?? './.data'),
    ...(process.env.HOTSAUCE_MASTER_KEY ? { masterKey: process.env.HOTSAUCE_MASTER_KEY } : {}),
  })
  const lost = org.undecryptable().filter((name) => !process.env[name])
  if (org.settings().setupComplete && lost.length > 0) {
    // Without this, the first sign would be "CLERK_SECRET_KEY is required", which hides the cause.
    console.error(
      `Saved keys can't be opened: ${lost.join(', ')}. HOTSAUCE_MASTER_KEY changed since they were ` +
        'saved (or the data volume moved without its master.key). Set the old HOTSAUCE_MASTER_KEY ' +
        'again, or set these keys in the environment, then start the server.',
    )
  }
  const config = loadConfig({
    ...org.toEnv(),
    HOTSAUCE_SETUP_PENDING: org.settings().setupComplete ? 'false' : 'true',
    ...process.env,
  })
  const services = createServices(config, { org })
  const { git, index, spaces, syncer, broadcaster, meetings } = services

  // A deploy or crash can kill git mid-write; clear what it left before anything uses a clone.
  await git.recoverClones()
  await spaces.ensureTeamSpace()
  // The spaces table is a cache of each repo's .hearth/space.yaml; rebuild it before serving.
  await rebuildRegistryFromClones(git, index)
  // Meetings that were recording when the server last stopped carry on where they were.
  const recovered = await meetings.sessions.recover()
  if (recovered > 0) console.log(`Recovered ${recovered} unsaved meeting session(s)`)
  // Clips that were being processed or transcribed when the server stopped carry on.
  const clipsResumed = services.clips.recover()
  if (clipsResumed > 0) console.log(`Resuming ${clipsResumed} clip job(s)`)
  meetings.reminders?.start()
  meetings.calendarSync?.start()

  const app = new Hono()
  // Once shutdown starts, requests on still-open connections are refused (the client retries
  // against the next machine) instead of queueing git work behind the drain.
  let stopping = false
  app.use('*', async (c, next) => {
    if (stopping)
      return c.json(
        { error: { code: 'unavailable', message: `${config.PRODUCT_NAME} is restarting` } },
        503,
      )
    await next()
  })
  const injectWebSocket = attachWebSocket(
    app,
    broadcaster,
    meetings.sockets,
    services.dictationSockets,
  )
  // Saving the organization's settings restarts the server so they take effect everywhere: a
  // graceful stop, then exit 75 so Fly, Docker or systemd starts it again (see fly.toml).
  const restart = () => {
    console.log('Organization settings changed: restarting to apply them')
    void shutdown(75)
  }
  app.route('/', createApp({ ...services, restart }))
  serveWebApp(app, WEB_DIST, config.PRODUCT_NAME)

  const poller = new Poller({
    syncer,
    spaces: () => index.listSpaces().map((s) => s.name),
    intervalMs: config.POLL_INTERVAL_MS,
  })
  const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    if (config.AUTH_MODE === 'setup') {
      const link = `${config.PUBLIC_URL.replace(/\/+$/, '')}/setup#token=${org.setupToken()}`
      console.log(
        `\n  ${config.PRODUCT_NAME} isn't set up yet. Open this link to set it up (it works once):\n\n    ${link}\n`,
      )
    }
    console.log(
      `${config.PRODUCT_NAME} listening on port ${info.port} (${config.AUTH_MODE} auth, ${config.HOST_KIND} host, ` +
        `${config.ASR_PROVIDER} transcriber, ${config.LLM_PROVIDER} LLM, data in ${config.DATA_DIR})`,
    )
  })
  injectWebSocket(server)
  broadcaster.start()
  meetings.sockets.start()
  poller.start()

  // Fly sends SIGTERM and kills after kill_timeout (30 s). Stop taking new connections first,
  // then let meetings and every queued git write finish, so no git process is killed mid-write.
  const shutdown = async (exitCode = 0) => {
    if (stopping) return
    stopping = true
    server.close()
    await poller.stop()
    broadcaster.stop()
    meetings.sockets.stop()
    await meetings.sessions.close()
    await meetings.reminders?.close()
    await meetings.calendarSync?.close()
    // Requests that were mid-flight when shutdown began may queue a write after the first
    // drain; a second pass, a moment later, waits for those too.
    await git.drain()
    await new Promise((resolve) => setTimeout(resolve, 500))
    await git.drain()
    index.close()
    services.dictation.store.close()
    services.clips.close()
    services.clips.store.close()
    meetings.calendarSync?.cache.close()
    process.exit(exitCode)
  }
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
}

const NO_WEB_BUILD =
  'The web app is not built. In development, open the Vite dev server ' +
  '(http://localhost:5173); otherwise run `pnpm build` first.\n'

/** The built SPA, with every other non-API GET falling back to index.html for client routing. */
function serveWebApp(app: Hono, dir: string, productName: string): void {
  const built = existsSync(path.join(dir, 'index.html'))
  if (!built) console.warn(`No web app build at ${dir}; serving a placeholder page.`)
  // serveStatic resolves its root against the working directory.
  const root = path.relative(process.cwd(), dir) || '.'

  // The web app may not be framed (clickjacking on Stop, delete, share), and never loads plugins
  // or rebases its URLs. Scripts aren't restricted here: Clerk loads its own from its domain.
  app.use('*', async (c, next) => {
    await next()
    c.header(
      'Content-Security-Policy',
      "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
    )
    c.header('X-Frame-Options', 'DENY')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  })

  app.get('*', (c, next) => {
    const p = c.req.path
    // /ws without an upgrade header, an API path no route claimed, or /.well-known (an MCP
    // client looking for OAuth after a 401 must get a 404, not the web app).
    if (
      p === '/api' ||
      p.startsWith('/api/') ||
      p === '/ws' ||
      p.startsWith('/ws/') ||
      p === '/mcp' ||
      p.startsWith('/.well-known/')
    ) {
      return c.notFound()
    }
    return built ? next() : c.text(NO_WEB_BUILD)
  })
  if (!built) return
  // The install name is the organization's ("Hearth", "Acme"), not the build's.
  app.get('/manifest.webmanifest', (c) => {
    const file = path.join(dir, 'manifest.webmanifest')
    if (!existsSync(file)) return c.notFound()
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    manifest.name = productName
    manifest.short_name = productName
    manifest.description = `${productName}: docs, meetings and more for the team.`
    c.header('Content-Type', 'application/manifest+json')
    c.header('Cache-Control', 'no-cache')
    return c.body(JSON.stringify(manifest))
  })
  // The page title before the app boots (tab, link previews, history) is the organization's too.
  const shell = readFileSync(path.join(dir, 'index.html'), 'utf8').replace(
    /<title>[^<]*<\/title>/,
    `<title>${escapeHtml(productName)}</title>`,
  )
  const sendShell = (c: Context) => {
    c.header('Cache-Control', 'no-cache')
    return c.html(shell)
  }
  app.get('/', sendShell)
  app.get('/index.html', sendShell)
  app.get(
    '*',
    serveStatic({
      root,
      onFound: (_file, c) => {
        // Vite fingerprints everything under assets/; the rest (index.html, the service worker)
        // must be revalidated so a deploy shows up.
        const immutable = c.req.path.startsWith('/assets/')
        c.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
      },
    }),
  )
  // A built file that isn't there, such as an old build's chunk after a deploy, is a 404: the
  // app shell served in its place would be cached as that chunk by the service worker.
  app.get('/assets/*', (c) => c.notFound())
  app.get('/downloads/*', (c) => c.notFound())
  app.get('*', sendShell)
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
