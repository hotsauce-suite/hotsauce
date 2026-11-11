import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { type ErrorCode, HearthError } from '../errors.js'

/** `HearthError` → `{ error: { code, message } }` with its status; anything else → a generic 500. */
export function handleError(err: Error, c: Context): Response {
  if (err instanceof HearthError) {
    const error = {
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    }
    return c.json({ error }, err.status as ContentfulStatusCode)
  }
  // Hono's own: malformed JSON bodies, body limits.
  if (err instanceof HTTPException && err.status < 500) {
    return c.json(
      { error: { code: codeFor(err.status), message: err.message } },
      err.status as ContentfulStatusCode,
    )
  }
  console.error(`${c.req.method} ${c.req.path} failed:`, err)
  return c.json({ error: { code: 'internal', message: 'Something went wrong on the server' } }, 500)
}

function codeFor(status: number): ErrorCode {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  return 'bad_request'
}
