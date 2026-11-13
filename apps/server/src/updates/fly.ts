// The slice of the Fly Machines API the updater uses (https://fly.io/docs/machines/api/).
// Inside a Fly machine, Fly sets FLY_APP_NAME, FLY_MACHINE_ID, FLY_REGION and FLY_IMAGE_REF.

export interface FlyMachine {
  id: string
  state: string
  region: string
  instance_id: string
  config: FlyMachineConfig
}

export interface FlyMachineConfig {
  image: string
  metadata?: Record<string, string>
  [key: string]: unknown
}

/** Marks the short-lived machine that runs an update, so it never updates itself. */
export const HELPER_ROLE = 'hotsauce-updater'

export interface FlyApi {
  list(): Promise<FlyMachine[]>
  get(id: string): Promise<FlyMachine>
  update(id: string, config: FlyMachineConfig): Promise<FlyMachine>
  create(body: { region: string; config: Record<string, unknown> }): Promise<FlyMachine>
  waitStarted(id: string, instanceId: string): Promise<void>
}

export function flyApi(opts: {
  token: string
  app: string
  base?: string
  fetchFn?: typeof fetch
}): FlyApi {
  const base = `${opts.base ?? 'https://api.machines.dev'}/v1/apps/${encodeURIComponent(opts.app)}`
  const doFetch = opts.fetchFn ?? fetch
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(90_000),
    })
    if (!res.ok) {
      // Fly's error text names the problem (a bad token, an unknown image); never the token.
      const text = (await res.text()).slice(0, 300)
      throw new Error(`Fly ${method} ${path}: ${res.status} ${text}`)
    }
    const text = await res.text()
    return (text ? JSON.parse(text) : {}) as T
  }
  return {
    list: () => call<FlyMachine[]>('GET', '/machines'),
    get: (id) => call<FlyMachine>('GET', `/machines/${id}`),
    update: (id, config) => call<FlyMachine>('POST', `/machines/${id}`, { config }),
    create: (body) => call<FlyMachine>('POST', '/machines', body),
    waitStarted: async (id, instanceId) => {
      await call(
        'GET',
        `/machines/${id}/wait?state=started&timeout=60&instance_id=${encodeURIComponent(instanceId)}`,
      )
    },
  }
}
