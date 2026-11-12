import { z } from 'zod'

/** An optional key that also accepts an empty YAML value (`tags:` parses as null). */
function optional<T extends z.ZodType>(schema: T) {
  return z.preprocess((v) => v ?? undefined, schema.optional())
}

// Hand-written files often have `tags: planning` rather than a list.
const Tags = z.preprocess((v) => (typeof v === 'string' ? [v] : v), z.array(z.string()))

/** Unknown keys pass through untouched. */
export const DocFrontmatter = z.looseObject({
  id: z.string().min(1),
  title: optional(z.string()),
  created: optional(z.string()),
  tags: optional(Tags),
})
export type DocFrontmatter = z.infer<typeof DocFrontmatter>

export const MeetingFrontmatter = z.looseObject({
  id: z.string().min(1),
  type: z.literal('meeting'),
  title: z.string(),
  date: z.string(),
  duration_min: optional(z.number().nonnegative()),
  attendees: optional(z.array(z.string())),
  companies: optional(z.array(z.string())),
  template: optional(z.string()),
  calendar_event_id: optional(z.string()),
  /** Google's recurringEventId: earlier notes of the same series are context for enhancing. */
  calendar_series_id: optional(z.string()),
  transcript: optional(z.string()),
  /** Line ranges of the note written by AI, as `[first, last]` pairs. */
  ai_ranges: optional(z.array(z.tuple([z.number().int(), z.number().int()]))),
  models: optional(z.record(z.string(), z.string())),
  /** Who Claude thinks each unnamed voice is ("Speaker 1": "Priya Shah"), until the member confirms. */
  speaker_guesses: optional(z.record(z.string(), z.string())),
})
export type MeetingFrontmatter = z.infer<typeof MeetingFrontmatter>

/** `.hearth/space.yaml`. Ownership lives here, in Git, so it survives rebuilding the index. */
export const SpaceConfig = z
  .object({
    name: z.string().min(1),
    schema: z.literal(1),
    kind: z.enum(['team', 'personal']),
    /** The owner's email, stored lowercase. */
    owner: z.string().trim().toLowerCase().pipe(z.email()).optional(),
  })
  .superRefine((config, ctx) => {
    if (config.kind === 'personal' && config.owner === undefined) {
      ctx.addIssue({ code: 'custom', path: ['owner'], message: 'a personal space needs an owner' })
    }
  })
export type SpaceConfig = z.infer<typeof SpaceConfig>
