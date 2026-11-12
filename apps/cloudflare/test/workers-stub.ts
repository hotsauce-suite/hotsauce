// Just enough of `cloudflare:workers` to load the Worker module under Node in unit tests.
export class DurableObject {
  constructor(
    readonly ctx: unknown,
    readonly env: unknown,
  ) {}
}
export class WorkerEntrypoint {
  constructor(
    readonly ctx: unknown,
    readonly env: unknown,
  ) {}
}
