export type ErrorCode =
  | 'unauthorized'
  | 'domain_not_allowed'
  | 'forbidden'
  | 'not_found'
  | 'bad_request'
  | 'conflict'
  | 'push_failed'
  | 'host_error'
  | 'llm_error'
  | 'asr_error'
  | 'rate_limited'
  | 'not_configured'
  | 'setup_required'
  | 'internal'

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  domain_not_allowed: 403,
  forbidden: 403,
  not_found: 404,
  bad_request: 400,
  conflict: 409,
  push_failed: 503,
  host_error: 502,
  // The language model or the transcription service failed; the detail is in the server log.
  llm_error: 502,
  asr_error: 502,
  rate_limited: 429,
  // A feature whose provider key hasn't been added yet (Settings → Organization).
  not_configured: 503,
  // A fresh instance that hasn't been through the setup wizard yet.
  setup_required: 503,
  internal: 500,
}

export class HearthError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly details: unknown

  constructor(code: ErrorCode, message: string, opts?: { status?: number; details?: unknown }) {
    super(message)
    this.name = 'HearthError'
    this.code = code
    this.status = opts?.status ?? DEFAULT_STATUS[code]
    this.details = opts?.details
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } }
  }
}
