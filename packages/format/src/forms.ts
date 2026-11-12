// Hearth Forms (ARCHITECTURE §21): a form is `forms/<id>.md` in a space and each answer is
// `forms/<form id>/<answer id>.md` beside it. The question schema, the show-if rules and the
// answer check live here so the fill page and the server agree. Written fresh for Hearth.

import { z } from 'zod'

export const FORMS_FOLDER = 'forms'
export const MAX_QUESTIONS = 100
export const MAX_OPTIONS = 50
/** Files one answer may carry, across all its file questions, and each one's size. */
export const MAX_ANSWER_FILES = 3
export const MAX_ANSWER_FILE_BYTES = 10 * 1024 * 1024
export const MAX_SHORT_ANSWER = 500
export const MAX_LONG_ANSWER = 10_000

export const QUESTION_TYPES = [
  'short',
  'long',
  'email',
  'choice',
  'multi',
  'dropdown',
  'rating',
  'date',
  'file',
] as const
export type QuestionType = (typeof QUESTION_TYPES)[number]
/** Types whose answer is one or more of the question's options. */
export const OPTION_TYPES: readonly QuestionType[] = ['choice', 'multi', 'dropdown']

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/
const QUESTION_ID = /^[a-z0-9]{1,16}$/
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
// Deliberately loose: one @, something on each side, a dot in the domain, no spaces.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const formPath = (id: string) => `${FORMS_FOLDER}/${id}.md`
export const answerPath = (formId: string, answerId: string) =>
  `${FORMS_FOLDER}/${formId}/${answerId}.md`
export const isFormId = (id: string) => ULID.test(id)

/** `forms/<id>.md` → the form id; `forms/<form>/<answer>.md` → both; anything else null. */
export function formPathParts(path: string): { formId: string; answerId: string | null } | null {
  const parts = path.split('/')
  if (parts[0] !== FORMS_FOLDER || !path.endsWith('.md')) return null
  if (parts.length === 2) {
    const formId = (parts[1] ?? '').slice(0, -3)
    return ULID.test(formId) ? { formId, answerId: null } : null
  }
  if (parts.length === 3) {
    const formId = parts[1] ?? ''
    const answerId = (parts[2] ?? '').slice(0, -3)
    return ULID.test(formId) && ULID.test(answerId) ? { formId, answerId } : null
  }
  return null
}

export const ShowIf = z.object({
  /** An earlier choice, multiple-choice or dropdown question. */
  question: z.string().regex(QUESTION_ID),
  /** The option that shows this question (for multiple choice: one of those picked). */
  is: z.string().trim().min(1).max(200),
})
export type ShowIf = z.infer<typeof ShowIf>

export const Question = z.object({
  id: z.string().regex(QUESTION_ID),
  type: z.enum(QUESTION_TYPES),
  label: z.string().trim().min(1).max(300),
  help: z.string().max(500).optional(),
  required: z.boolean().default(false),
  options: z.array(z.string().trim().min(1).max(200)).max(MAX_OPTIONS).optional(),
  /** Rating questions: the top of the scale. */
  scale: z.union([z.literal(5), z.literal(10)]).optional(),
  show_if: ShowIf.optional(),
})
export type Question = z.infer<typeof Question>

export const FORM_ACCESS = ['team', 'public'] as const
export type FormAccess = (typeof FORM_ACCESS)[number]

/** A form's frontmatter. Unknown keys pass through. */
export const FormFrontmatter = z.looseObject({
  id: z.string().regex(ULID),
  type: z.literal('form'),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).default(''),
  questions: z.array(Question).max(MAX_QUESTIONS).default([]),
  /** Who may answer: signed-in members, or anyone with the link. */
  access: z.enum(FORM_ACCESS).default('team'),
  /** Whether the form takes answers now. */
  open: z.boolean().default(true),
  /** The chat room new answers are posted to; null for none. */
  room: z.string().max(40).nullable().default(null),
  /** The fill link's token: `/f/<link>`. */
  link: z.string().min(16).max(64),
  created: z.string().optional(),
  created_by: z.string().optional(),
  updated: z.string().optional(),
  updated_by: z.string().optional(),
})
export type FormFrontmatter = z.infer<typeof FormFrontmatter>

/** What's wrong with a form's questions as a whole (ids, options, show-if), or null. */
export function questionsProblem(questions: readonly Question[]): string | null {
  const seen = new Map<string, Question>()
  for (const [i, q] of questions.entries()) {
    const at = `Question ${i + 1}`
    if (seen.has(q.id)) return `${at} has the same id as another question`
    if (!q.label?.trim()) return `${at} needs its wording`
    const hasOptions = OPTION_TYPES.includes(q.type)
    if (hasOptions) {
      const opts = q.options ?? []
      if (opts.length === 0) return `${at} needs at least one option`
      if (opts.some((o) => !o.trim())) return `${at} has an empty option`
      if (new Set(opts.map((o) => o.trim().toLowerCase())).size !== opts.length) {
        return `${at} has the same option twice`
      }
    } else if (q.options !== undefined && q.options.length > 0) {
      return `${at} can't have options`
    }
    if (q.show_if) {
      const by = seen.get(q.show_if.question)
      if (!by) return `${at} depends on a question that isn't before it`
      if (!OPTION_TYPES.includes(by.type)) return `${at} depends on a question without options`
      if (!(by.options ?? []).map((o) => o.trim()).includes(q.show_if.is.trim())) {
        return `${at} depends on an option that question doesn't have`
      }
    }
    seen.set(q.id, q)
  }
  return null
}

/** A stored file an answer carries (Hearth Files, ARCHITECTURE §18). */
export interface AnswerFile {
  id: string
  name: string
  size: number
}

export type AnswerValue = string | string[] | number | AnswerFile[]
export type Answers = Record<string, AnswerValue>

const FileRef = z.object({
  id: z.string().regex(ULID),
  name: z.string().min(1).max(200),
  size: z.number().int().min(0),
})

/** Whether `q` is shown, given the answers so far (show-if chains follow earlier questions). */
export function visibleQuestions(questions: readonly Question[], answers: Answers): Question[] {
  const shown = new Set<string>()
  const out: Question[] = []
  for (const q of questions) {
    if (q.show_if) {
      if (!shown.has(q.show_if.question)) continue
      const v = answers[q.show_if.question]
      const hit = Array.isArray(v) ? (v as unknown[]).includes(q.show_if.is) : v === q.show_if.is
      if (!hit) continue
    }
    shown.add(q.id)
    out.push(q)
  }
  return out
}

function isRealDate(s: string): boolean {
  const m = DATE.exec(s)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(y, mo - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
}

const isBlank = (v: unknown) =>
  v === undefined ||
  v === null ||
  (typeof v === 'string' && v.trim() === '') ||
  (Array.isArray(v) && v.length === 0)

export type CheckResult =
  | { ok: true; answers: Answers }
  | { ok: false; errors: Record<string, string> }

/**
 * Checks an answer against the form: only shown questions count (a hidden one's answer is
 * dropped), required ones are filled, and each value fits its type. Files are checked by count
 * and size; the caller stores them and puts their references in.
 */
export function checkAnswers(
  questions: readonly Question[],
  raw: Record<string, unknown>,
): CheckResult {
  const errors: Record<string, string> = {}
  const answers: Answers = {}
  // Visibility only reads option answers, so the raw values decide it.
  for (const q of visibleQuestions(questions, raw as Answers)) {
    const v = raw[q.id]
    if (isBlank(v)) {
      if (q.required) errors[q.id] = 'This question needs an answer'
      continue
    }
    const problem = valueProblem(q, v)
    if (problem) {
      errors[q.id] = problem
      continue
    }
    answers[q.id] =
      typeof v === 'string'
        ? v.trim()
        : q.type === 'multi'
          ? [...(v as string[])]
          : (v as AnswerValue)
  }
  let files = 0
  for (const v of Object.values(answers)) {
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object') files += v.length
  }
  if (files > MAX_ANSWER_FILES) {
    for (const q of questions) {
      if (q.type === 'file' && answers[q.id])
        errors[q.id] = `At most ${MAX_ANSWER_FILES} files in all`
    }
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, answers }
}

function valueProblem(q: Question, v: unknown): string | null {
  switch (q.type) {
    case 'short':
    case 'long': {
      if (typeof v !== 'string') return 'Expected text'
      const max = q.type === 'short' ? MAX_SHORT_ANSWER : MAX_LONG_ANSWER
      return v.length > max ? `At most ${max.toLocaleString('en-US')} characters` : null
    }
    case 'email':
      if (typeof v !== 'string') return 'Expected an email address'
      return v.length <= 254 && EMAIL.test(v.trim())
        ? null
        : 'That doesn’t look like an email address'
    case 'choice':
    case 'dropdown':
      return typeof v === 'string' && (q.options ?? []).includes(v)
        ? null
        : 'Pick one of the options'
    case 'multi':
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return 'Pick from the options'
      if (new Set(v).size !== v.length) return 'Each option once'
      return v.every((x) => (q.options ?? []).includes(x)) ? null : 'Pick from the options'
    case 'rating': {
      const top = q.scale ?? 5
      return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= top
        ? null
        : `Pick 1 to ${top}`
    }
    case 'date':
      return typeof v === 'string' && isRealDate(v) ? null : 'Expected a date'
    case 'file': {
      const parsed = z.array(FileRef).safeParse(v)
      if (!parsed.success) return 'Expected files'
      return parsed.data.some((f) => f.size > MAX_ANSWER_FILE_BYTES)
        ? 'Each file is at most 10 MB'
        : null
    }
  }
}

/** An answer's frontmatter. Unknown keys pass through. */
export const AnswerFrontmatter = z.looseObject({
  id: z.string().regex(ULID),
  type: z.literal('form-answer'),
  form: z.string().regex(ULID),
  title: z.string().optional(),
  submitted: z.string(),
  /** The member who answered; null for someone signed out on a public form. */
  submitted_by: z.string().nullable().default(null),
  answers: z.record(z.string(), z.unknown()).default({}),
})
export type AnswerFrontmatter = z.infer<typeof AnswerFrontmatter>

/** One answer shown as text: what search reads, and what a chat post previews. */
export function answerText(questions: readonly Question[], answers: Answers): string {
  const lines: string[] = []
  for (const q of questions) {
    const v = answers[q.id]
    if (v === undefined) continue
    lines.push(`**${q.label}**`, displayValue(v), '')
  }
  return lines.join('\n').trim()
}

/** A value as one line of plain text. */
export function displayValue(v: AnswerValue | undefined): string {
  if (v === undefined) return ''
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return v
  if (v.length > 0 && typeof v[0] === 'object')
    return (v as AnswerFile[]).map((f) => f.name).join(', ')
  return (v as string[]).join(', ')
}

function csvCell(s: string): string {
  // A leading = + - @ would run as a formula in a spreadsheet; a quote mark keeps it text.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** Every answer as CSV: submitted, by, then one column per question (in form order). */
export function answersCsv(
  questions: readonly Question[],
  rows: ReadonlyArray<{ submitted: string; submittedBy: string | null; answers: Answers }>,
): string {
  const header = ['Submitted', 'From', ...questions.map((q) => q.label)]
  const lines = [header.map(csvCell).join(',')]
  for (const r of rows) {
    const cells = [
      r.submitted,
      r.submittedBy ?? '',
      ...questions.map((q) => displayValue(r.answers[q.id])),
    ]
    lines.push(cells.map(csvCell).join(','))
  }
  return `${lines.join('\r\n')}\r\n`
}

/** A new question id that isn't in `taken`. */
export function newQuestionId(taken: Iterable<string>, random: () => number = Math.random): string {
  const used = new Set(taken)
  for (;;) {
    const id = `q${Math.floor(random() * 36 ** 6)
      .toString(36)
      .padStart(6, '0')}`
    if (!used.has(id)) return id
  }
}
