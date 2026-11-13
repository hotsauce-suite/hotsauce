import type { FlyApi, FlyMachine, FlyMachineConfig } from './fly.js'

/** An in-memory Fly app for tests: machines, their images, and every call made. */
export class FakeFly implements FlyApi {
  machines: FlyMachine[] = []
  created: Array<{ region: string; config: Record<string, unknown> }> = []
  calls: string[] = []
  /** Images Fly refuses to start (an image that doesn't exist, say). */
  refuse = new Set<string>()
  #n = 0

  add(id: string, image: string, metadata?: Record<string, string>): void {
    this.machines.push({
      id,
      state: 'started',
      region: 'iad',
      instance_id: `i${this.#n++}`,
      config: { image, ...(metadata ? { metadata } : {}), services: [{ internal_port: 3000 }] },
    })
  }

  image(id: string): string | undefined {
    return this.machines.find((m) => m.id === id)?.config.image
  }

  async list(): Promise<FlyMachine[]> {
    this.calls.push('list')
    return structuredClone(this.machines)
  }
  async get(id: string): Promise<FlyMachine> {
    const m = this.machines.find((x) => x.id === id)
    if (!m) throw new Error(`no machine ${id}`)
    return structuredClone(m)
  }
  async update(id: string, config: FlyMachineConfig): Promise<FlyMachine> {
    this.calls.push(`update ${id} ${config.image}`)
    if (this.refuse.has(config.image)) throw new Error(`Fly POST /machines/${id}: 422 bad image`)
    const m = this.machines.find((x) => x.id === id)
    if (!m) throw new Error(`no machine ${id}`)
    m.config = structuredClone(config)
    m.instance_id = `i${this.#n++}`
    return structuredClone(m)
  }
  async create(body: { region: string; config: Record<string, unknown> }): Promise<FlyMachine> {
    this.calls.push('create')
    this.created.push(structuredClone(body))
    return {
      id: 'helper',
      state: 'created',
      region: body.region,
      instance_id: 'h',
      config: { image: String(body.config.image) },
    }
  }
  async waitStarted(id: string): Promise<void> {
    this.calls.push(`wait ${id}`)
  }
}
