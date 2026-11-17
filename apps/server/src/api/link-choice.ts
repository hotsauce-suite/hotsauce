import { z } from 'zod'
import { EXPIRY_DAYS, type LinkOptions } from '../shares/index.js'

/** What Share sends when it turns a link on: who it's for and when it ends. */
export const LinkChoice = {
  anyone: z.boolean().optional(),
  expiresDays: z
    .number()
    .int()
    .refine((d) => (EXPIRY_DAYS as readonly number[]).includes(d), 'Pick 7, 30 or 0 (never)')
    .optional(),
}
export const linkOptions = (body: {
  anyone?: boolean | undefined
  expiresDays?: number | undefined
}): LinkOptions => ({
  ...(body.anyone === undefined ? {} : { anyone: body.anyone }),
  ...(body.expiresDays === undefined ? {} : { expiresDays: body.expiresDays as 7 | 30 | 0 }),
})
