/**
 * Hotsauce on Cloudflare (docs/PLAN-cloudflare-deploy.md): this Worker sends every request,
 * WebSockets included, to one container running the same Docker image as Fly and Docker installs,
 * and answers the container's state store from R2. A cron trigger keeps the container running, so
 * calendar sync, reminders and nightly briefs carry on with nobody signed in.
 */
import { Container } from '@cloudflare/containers'
import { alwaysOn, containerEnv, STATE_HOST } from './container-env.js'
import { handleState, type StateBucket } from './state-gateway.js'

interface Env {
  HOTSAUCE: DurableObjectNamespace<HotsauceServer>
  STATE: StateBucket
  [name: string]: unknown
}

const PORT = 3000
// Restoring state, cloning repositories from GitHub and rebuilding the index before it listens.
const START_TIMEOUT_MS = 5 * 60_000
const ORIGIN_KEY = 'publicOrigin'

export class HotsauceServer extends Container<Env> {
  defaultPort = PORT
  sleepAfter = '30m'

  // Registered through the base class's static setter: a class field would only shadow it, and the
  // library's ContainerProxy (exported below) would never find the handler.
  static {
    HotsauceServer.outboundByHost = {
      [STATE_HOST]: (request: Request, env: Env) => handleState(request, env.STATE),
    }
  }

  /**
   * The address people reach the site at: PUBLIC_URL when set, otherwise the first address anyone
   * opened it at, kept from then on so a later visit through another hostname doesn't change it.
   */
  async #origin(seen: string | null): Promise<string | null> {
    if (this.env.PUBLIC_URL) return String(this.env.PUBLIC_URL)
    const saved = await this.ctx.storage.get<string>(ORIGIN_KEY)
    if (saved) return saved
    if (seen) await this.ctx.storage.put(ORIGIN_KEY, seen)
    return seen
  }

  /**
   * Starts the container if it isn't running. The environment is set on every call, because the
   * library starts a stopped container from `envVars` on its own too, and a fresh instance of this
   * object would otherwise start it with none (no state store, no master key).
   */
  async ensureStarted(seen: string | null): Promise<void> {
    this.envVars = containerEnv(this.env, await this.#origin(seen))
    if (this.ctx.container?.running) return
    await this.startAndWaitForPorts({
      ports: PORT,
      cancellationOptions: { portReadyTimeoutMS: START_TIMEOUT_MS },
    })
  }

  override async fetch(request: Request): Promise<Response> {
    await this.ensureStarted(new URL(request.url).origin)
    return super.fetch(request)
  }

  /** The cron's call: start the container if it stopped, and count as activity. */
  async keepAlive(): Promise<void> {
    // Before anyone has opened the site there's no address to give it; the first visit starts it.
    if (!(await this.#origin(null))) return
    await this.ensureStarted(null)
    this.renewActivityTimeout()
  }

  override async onActivityExpired(): Promise<void> {
    if (alwaysOn(this.env)) {
      this.renewActivityTimeout()
      return
    }
    await this.stop()
  }
}

// The library needs this export to route the container's outbound requests to `outboundByHost`.
export { ContainerProxy } from '@cloudflare/containers'

const server = (env: Env) => env.HOTSAUCE.get(env.HOTSAUCE.idFromName('main'))

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return server(env).fetch(request)
  },
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    if (!alwaysOn(env)) return
    ctx.waitUntil(server(env).keepAlive())
  },
} satisfies ExportedHandler<Env>
