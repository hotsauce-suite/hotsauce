import { zValidator } from '@hono/zod-validator'
import type { ValidationTargets } from 'hono'
import { z } from 'zod'
import { HearthError } from '../errors.js'

/** `zValidator` that fails with the API's own `bad_request` error shape. */
export function valid<Target extends keyof ValidationTargets, Schema extends z.ZodType>(
  target: Target,
  schema: Schema,
) {
  return zValidator(target, schema, (result) => {
    if (!result.success) {
      const problems = result.error.issues.map((i) => `${i.path.join('.') || target}: ${i.message}`)
      throw new HearthError('bad_request', `Invalid ${target}: ${problems.join('; ')}`)
    }
  })
}

/** A repo path as sent by a client; GitStore validates and normalizes it. */
export const PathParam = z.string().min(1)
