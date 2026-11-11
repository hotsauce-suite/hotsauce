import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

/** Minimal authenticated fetch against a host's REST API, for checks the adapter doesn't expose. */
export function restClient(baseUrl: string, headers: Record<string, string>) {
  return async (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
}

export interface CapturedRequest {
  headers: Record<string, string>
  body: string
}

/**
 * An HTTP listener on this machine that records the first request it gets, for real webhook
 * deliveries. `publicHost` is how the git host reaches us (e.g. host.docker.internal).
 */
export async function webhookReceiver(publicHost: string) {
  let resolveFirst: (req: CapturedRequest) => void = () => {}
  const first = new Promise<CapturedRequest>((resolve) => {
    resolveFirst = resolve
  })
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      res.end('ok')
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(', ') : value
      }
      resolveFirst({ headers, body: Buffer.concat(chunks).toString('utf8') })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://${publicHost}:${port}/api/webhooks/git`,
    first,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timed out: ${what}`)), ms)),
  ])
}
