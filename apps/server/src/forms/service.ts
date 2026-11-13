// Hearth Forms (ARCHITECTURE §21): a form is `forms/<id>.md` in a space, each answer
// `forms/<form id>/<answer id>.md` beside it. Members build forms in the app; the fill page at
// `/f/<link>` takes answers from members (team forms) or anyone with the link (public forms,
// behind Turnstile and rate limits). Written fresh for Hearth; no form builder's code was copied.

import { randomBytes } from 'node:crypto'
import {
  AnswerFrontmatter,
  type Answers,
  answerPath,
  answersCsv,
  answerText,
  type Column,
  checkAnswers,
  displayValue,
  FORMS_FOLDER,
  type FormAccess,
  FormFrontmatter,
  formPath,
  isFormId,
  MAX_ANSWER_FILE_BYTES,
  MAX_ANSWER_FILES,
  parseFrontmatter,
  type Question,
  questionsProblem,
  SPACE_LAYOUT,
} from '@hearth/format'
import { ulid } from 'ulid'
import { stringify as toYaml } from 'yaml'
import type { Principal } from '../auth/index.js'
import { RateLimiter } from '../dictation/rate-limit.js'
import { HearthError } from '../errors.js'
import type { Files } from '../files/index.js'
import {
  type Author,
  type Change,
  formatCommitMessage,
  type GitStore,
  withVia,
} from '../git/index.js'
import type { Index } from '../index/index.js'
import type { LLM } from '../meetings/llm/types.js'
import type { RobotCheck } from '../scheduling/turnstile.js'
import type { SpaceService } from '../spaces/index.js'
import type { Syncer } from '../sync/index.js'
import type { ChatRooms } from './rooms.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
export const ANSWERS_PER_IP_PER_HOUR = 10
export const ANSWERS_PER_FORM_PER_DAY = 200
const PAGE_VIEWS_PER_IP_PER_HOUR = 600
const LINK = /^[A-Za-z0-9_-]{16,64}$/
/** What the summary reads at most: the newest answers, up to this many characters. */
export const SUMMARY_MAX_ANSWERS = 300
const SUMMARY_MAX_CHARS = 150_000
const WRITE_ATTEMPTS = 3

export interface FormSummary {
  space: string
  id: string
  title: string
  access: FormAccess
  open: boolean
  answerCount: number
  lastAnswer: string | null
  updated: string | null
  updatedBy: string | null
}

export interface FormView extends FormSummary {
  description: string
  questions: Question[]
  room: string | null
  /** The fill page: `<PUBLIC_URL>/f/<link>`. */
  url: string
  created: string | null
  createdBy: string | null
  blobOid: string
}

export interface FormInput {
  title: string
  description: string
  questions: unknown[]
  access: FormAccess
  open: boolean
  room: string | null
  blobOid: string
}

export interface FillPage {
  title: string
  description: string
  questions: Question[]
  access: FormAccess
  open: boolean
  /** Whether this server can take this form's answers now (a public form needs Turnstile). */
  canTakeAnswers: boolean
  /** The robot check a signed-out person passes; null when signed in or for a team form. */
  robotCheck: RobotCheck['widget'] | null
  maxFiles: number
  maxFileBytes: number
}

export interface AnswerRow {
  id: string
  submitted: string
  submittedBy: string | null
  answers: Answers
}

export interface UploadedFile {
  question: string
  name: string
  type: string
  bytes: Uint8Array
}

export interface Tally {
  question: string
  /** Choice questions: how many picked each option (in the form's order). */
  counts?: Array<{ option: string; count: number }>
  /** Rating questions: the mean and how many rated. */
  average?: number
  answered: number
}

export interface FormsDeps {
  git: Pick<GitStore, 'readFile' | 'commit'>
  index: Pick<Index, 'listFiles' | 'listSpaces'>
  spaces: Pick<SpaceService, 'canAccess'>
  syncer: Pick<Syncer, 'afterHeadChanged'>
  files: Pick<Files, 'storeFormFile' | 'available'>
  rooms: Pick<ChatRooms, 'has' | 'post'>
  /** Null: AI isn't set up, so there is no summary. */
  llm: LLM | null
  model: string
  /** Null: this server can't take signed-out answers (production without a Turnstile secret). */
  robotCheck: RobotCheck | null
  publicUrl: string
  productName: string
  now?: () => Date
  log?: (message: string) => void
}

export class Forms {
  readonly #deps: FormsDeps
  readonly #now: () => Date
  readonly #log: (message: string) => void
  readonly #perIp = new RateLimiter(ANSWERS_PER_IP_PER_HOUR, HOUR)
  readonly #perForm = new RateLimiter(ANSWERS_PER_FORM_PER_DAY, DAY)
  readonly #views = new RateLimiter(PAGE_VIEWS_PER_IP_PER_HOUR, HOUR)

  constructor(deps: FormsDeps) {
    this.#deps = deps
    this.#now = deps.now ?? (() => new Date())
    this.#log = deps.log ?? console.warn
  }

  get canSummarize(): boolean {
    return this.#deps.llm !== null
  }

  // ── building ─────────────────────────────────────────────────────────

  /** Forms in every space the member can open, most recently changed first. */
  list(principal: Principal): FormSummary[] {
    const out: FormSummary[] = []
    for (const { name } of this.#deps.index.listSpaces()) {
      if (!this.#deps.spaces.canAccess(principal, name)) continue
      for (const row of this.#deps.index.listFiles({ space: name, kind: 'form' })) {
        const fm = FormFrontmatter.safeParse(row.frontmatter ?? {})
        if (fm.success && row.path === formPath(fm.data.id)) out.push(this.#summary(name, fm.data))
      }
    }
    return out.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''))
  }

  async create(
    principal: Principal,
    space: string,
    title: string,
    via?: string,
  ): Promise<FormView> {
    this.#assertAccess(principal, space)
    const clean = title.replace(/\s+/g, ' ').trim().slice(0, 200) || 'Untitled form'
    const id = ulid()
    const now = this.#iso()
    const fm: FormFrontmatter = FormFrontmatter.parse({
      id,
      type: 'form',
      title: clean,
      description: '',
      questions: [{ id: 'q1', type: 'short', label: 'Your name', required: true }],
      access: 'team',
      open: true,
      room: null,
      link: randomBytes(18).toString('base64url'),
      created: now,
      created_by: principal.email,
      updated: now,
      updated_by: principal.email,
    })
    await this.#commit(space, principal, {
      changes: [{ path: formPath(id), content: formFile(fm) }],
      verb: 'create',
      title: clean,
      via,
      unchanged: { path: formPath(id), blobOid: null },
    })
    return this.get(principal, space, id)
  }

  async get(principal: Principal, space: string, id: string): Promise<FormView> {
    this.#assertAccess(principal, space)
    const { fm, blobOid } = await this.#readForm(space, id)
    return this.#view(space, fm, blobOid)
  }

  /** Saves the whole form; `blobOid` is the version edited, and a different one is a 409. */
  async save(
    principal: Principal,
    space: string,
    id: string,
    input: FormInput,
    via?: string,
  ): Promise<FormView> {
    this.#assertAccess(principal, space)
    const { fm } = await this.#readForm(space, id)
    const parsed = FormFrontmatter.safeParse({
      ...fm,
      title: input.title.replace(/\s+/g, ' ').trim(),
      description: input.description,
      questions: input.questions,
      access: input.access,
      open: input.open,
      room: input.room,
      updated: this.#iso(),
      updated_by: principal.email,
    })
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw new HearthError('bad_request', `${issue?.path.join('.') ?? 'form'}: ${issue?.message}`)
    }
    const problem = questionsProblem(parsed.data.questions)
    if (problem) throw new HearthError('bad_request', problem)
    if (parsed.data.room !== null && !this.#deps.rooms.has(parsed.data.room)) {
      throw new HearthError('bad_request', 'That chat room was removed; pick another')
    }
    await this.#commit(space, principal, {
      changes: [{ path: formPath(id), content: formFile(parsed.data) }],
      verb: 'edit',
      title: parsed.data.title,
      via,
      unchanged: { path: formPath(id), blobOid: input.blobOid },
    })
    return this.get(principal, space, id)
  }

  /** Moves the form and all its answers to the space's trash in one commit. */
  async remove(principal: Principal, space: string, id: string, via?: string): Promise<void> {
    this.#assertAccess(principal, space)
    const { fm, content, blobOid } = await this.#readForm(space, id)
    const trash = `${SPACE_LAYOUT.trash}/${this.#iso().slice(0, 10)}-${id.slice(-8)}`
    const changes: Change[] = [
      { path: `${trash}/${formPath(id)}`, content },
      { path: formPath(id), content: null },
    ]
    for (const row of this.#answerRows(space, id)) {
      const file = await this.#deps.git.readFile(space, row.path).catch(() => null)
      if (!file) continue
      changes.push(
        { path: `${trash}/${row.path}`, content: file.content },
        { path: row.path, content: null },
      )
    }
    await this.#commit(space, principal, {
      changes,
      verb: 'delete',
      title: fm.title,
      via,
      unchanged: { path: formPath(id), blobOid },
    })
  }

  // ── answers, for members who can open the form's space ─────────────────

  answers(principal: Principal, space: string, id: string): AnswerRow[] {
    this.#assertAccess(principal, space)
    return this.#answers(space, id)
  }

  async removeAnswer(
    principal: Principal,
    space: string,
    id: string,
    answerId: string,
    via?: string,
  ): Promise<void> {
    this.#assertAccess(principal, space)
    if (!isFormId(answerId)) throw new HearthError('not_found', 'No such answer')
    const { fm } = await this.#readForm(space, id)
    const at = answerPath(id, answerId)
    const file = await this.#deps.git.readFile(space, at).catch((err) => {
      throw err instanceof HearthError && err.code === 'not_found'
        ? new HearthError('not_found', 'No such answer')
        : err
    })
    const trash = `${SPACE_LAYOUT.trash}/${this.#iso().slice(0, 10)}-${answerId.slice(-8)}`
    await this.#commit(space, principal, {
      changes: [
        { path: `${trash}/${at}`, content: file.content },
        { path: at, content: null },
      ],
      verb: 'delete an answer to',
      title: fm.title,
      via,
      unchanged: { path: at, blobOid: file.blobOid },
    })
  }

  async csv(
    principal: Principal,
    space: string,
    id: string,
  ): Promise<{ title: string; csv: string }> {
    this.#assertAccess(principal, space)
    const { fm } = await this.#readForm(space, id)
    return { title: fm.title, csv: answersCsv(fm.questions, this.#answers(space, id)) }
  }

  /**
   * Every answer as a table (ARCHITECTURE §22.6): a header row, then one row per answer, newest
   * first, with a column type for each question so Tables shows it the same way.
   */
  async answerTable(
    principal: Principal,
    space: string,
    id: string,
  ): Promise<{ title: string; columns: Column[]; cells: string[][] }> {
    this.#assertAccess(principal, space)
    const { fm } = await this.#readForm(space, id)
    const columns: Column[] = [{ type: 'text' }, { type: 'person' }, ...fm.questions.map(columnFor)]
    const cells = [
      ['Submitted', 'From', ...fm.questions.map((q) => q.label)],
      ...this.#answers(space, id).map((a) => [
        a.submitted.replace('T', ' ').replace(/:\d\dZ$/, ''),
        a.submittedBy ?? '',
        ...fm.questions.map((q) => displayValue(a.answers[q.id])),
      ]),
    ]
    // Answers are data, never formulas: one starting `=` is shown and copied as text.
    const text = cells.map((row) => row.map((c) => (c.startsWith('=') ? `'${c}` : c)))
    return { title: fm.title, columns, cells: text }
  }

  /** Counts for choice and rating questions, and Claude's summary of the newest answers. */
  async summarize(
    principal: Principal,
    space: string,
    id: string,
  ): Promise<{ summary: string | null; tallies: Tally[]; read: number; total: number }> {
    this.#assertAccess(principal, space)
    const { fm } = await this.#readForm(space, id)
    const all = this.#answers(space, id)
    const tallies = tally(fm.questions, all)
    if (all.length === 0) return { summary: null, tallies, read: 0, total: 0 }
    const llm = this.#deps.llm
    if (!llm) throw new HearthError('not_configured', 'AI isn’t set up on this server')
    const blocks: string[] = []
    let chars = 0
    for (const a of all.slice(0, SUMMARY_MAX_ANSWERS)) {
      const block = `## Answer ${blocks.length + 1} (${a.submitted.slice(0, 10)})\n${answerText(fm.questions, a.answers)}`
      if (chars + block.length > SUMMARY_MAX_CHARS) break
      chars += block.length
      blocks.push(block)
    }
    const { text } = await llm
      .complete({
        model: this.#deps.model,
        maxTokens: 1500,
        system: SUMMARY_SYSTEM,
        messages: [
          {
            role: 'user',
            content: `Form: ${fm.title}\n${fm.description ? `About it: ${fm.description}\n` : ''}Questions: ${fm.questions.map((q) => q.label).join(' | ')}\n\n${blocks.join('\n\n')}`,
          },
        ],
      })
      .catch((err) => {
        this.#log(`forms: summary failed: ${err}`)
        throw new HearthError('llm_error', 'Claude couldn’t summarize the answers; try again')
      })
    return { summary: text.trim(), tallies, read: blocks.length, total: all.length }
  }

  // ── the fill page ────────────────────────────────────────────────────

  /** The form as the person answering sees it. A team form needs a member signed in. */
  async fillPage(link: string, principal: Principal | null, ip: string | null): Promise<FillPage> {
    if (!this.#views.take(ip ?? 'unknown')) {
      throw new HearthError('rate_limited', 'Too many requests; try again later')
    }
    const { fm } = await this.#byLink(link)
    if (fm.access === 'team' && !principal) {
      throw new HearthError('unauthorized', 'Sign in to answer this form')
    }
    const needsCheck = fm.access === 'public' && !principal
    return {
      title: fm.title,
      description: fm.description,
      questions: fm.questions,
      access: fm.access,
      open: fm.open,
      canTakeAnswers: fm.open && (!needsCheck || this.#deps.robotCheck !== null),
      robotCheck: needsCheck ? (this.#deps.robotCheck?.widget ?? null) : null,
      maxFiles: MAX_ANSWER_FILES,
      maxFileBytes: MAX_ANSWER_FILE_BYTES,
    }
  }

  /**
   * Everything that can refuse an answer before its body is read (the route calls it first, so a
   * bad link, a closed form or a busy address never costs a 30 MB upload). Says whether the form
   * takes files at all.
   */
  async precheck(
    link: string,
    principal: Principal | null,
    ip: string | null,
  ): Promise<{ files: boolean }> {
    const { fm } = await this.#gate(link, principal, ip)
    return { files: fm.questions.some((q) => q.type === 'file') }
  }

  async #gate(link: string, principal: Principal | null, ip: string | null) {
    const found = await this.#byLink(link)
    const { fm } = found
    if (fm.access === 'team' && !principal) {
      throw new HearthError('unauthorized', 'Sign in to answer this form')
    }
    if (!fm.open) throw new HearthError('conflict', 'This form isn’t taking answers any more')
    if (principal === null) {
      if (!this.#deps.robotCheck) {
        throw new HearthError('not_configured', 'This form can’t take answers yet')
      }
      if (!this.#perIp.allows(ip ?? 'unknown')) {
        throw new HearthError('rate_limited', 'Too many answers from here; try again in an hour')
      }
    }
    if (!this.#perForm.allows(fm.id)) {
      throw new HearthError(
        'rate_limited',
        'This form has had a lot of answers today; try tomorrow',
      )
    }
    return found
  }

  /** Takes one answer: checks, stores its files in Hearth Files, commits it, posts to chat. */
  async submit(
    link: string,
    principal: Principal | null,
    input: {
      answers: Record<string, unknown>
      token: string
      files: UploadedFile[]
      ip: string | null
    },
  ): Promise<{ id: string }> {
    const { space, fm } = await this.#gate(link, principal, input.ip)
    const check = this.#deps.robotCheck
    if (principal === null && check) {
      if (!this.#perIp.take(input.ip ?? 'unknown')) {
        throw new HearthError('rate_limited', 'Too many answers from here; try again in an hour')
      }
      if (!(await check.verify(input.token, input.ip))) {
        throw new HearthError('forbidden', 'The robot check didn’t pass; try again')
      }
    }
    if (!this.#perForm.allows(fm.id)) {
      throw new HearthError(
        'rate_limited',
        'This form has had a lot of answers today; try tomorrow',
      )
    }

    // File answers come only from the uploads, never from the JSON, so an answer can't point at
    // someone else's stored file. Ids are filled in once the files are stored.
    const raw: Record<string, unknown> = { ...input.answers }
    for (const q of fm.questions) {
      if (q.type !== 'file') continue
      const mine = input.files.filter((f) => f.question === q.id)
      raw[q.id] = mine.map((f) => ({
        id: PLACEHOLDER_ID,
        name: (f.name || 'file').slice(0, 200),
        size: f.bytes.length,
      }))
    }
    const checked = checkAnswers(fm.questions, raw)
    if (!checked.ok) {
      throw new HearthError('bad_request', 'Some answers need another look', {
        details: { errors: checked.errors },
      })
    }
    const answers = checked.answers
    const author: Author = principal
      ? { name: principal.name, email: principal.email }
      : { name: `${this.#deps.productName} Forms`, email: `forms@${hostOf(this.#deps.publicUrl)}` }
    const fileQuestions = fm.questions.filter(
      (q) => q.type === 'file' && answers[q.id] !== undefined,
    )
    if (fileQuestions.length > 0) {
      if (!this.#deps.files.available) {
        throw new HearthError('not_configured', 'File uploads aren’t set up on this server')
      }
      for (const q of fileQuestions) {
        const stored = []
        for (const f of input.files.filter((x) => x.question === q.id)) {
          const view = await this.#deps.files.storeFormFile(
            author,
            {
              space,
              folder: `Forms/${folderName(fm.title)}`,
              name: f.name || 'file',
              mime: f.type,
              bytes: f.bytes,
            },
            'forms',
          )
          stored.push({ id: view.id, name: view.name, size: view.size })
        }
        answers[q.id] = stored
      }
    }

    const id = ulid()
    const answerFm: AnswerFrontmatter = {
      id,
      type: 'form-answer',
      form: fm.id,
      title: `Answer to ${fm.title}`,
      submitted: this.#iso(),
      submitted_by: principal?.email ?? null,
      answers,
    }
    const text = answerText(fm.questions, answers)
    await this.#commit(space, author, {
      changes: [{ path: answerPath(fm.id, id), content: `---\n${toYaml(answerFm)}---\n${text}\n` }],
      verb: 'answer',
      title: fm.title,
      via: principal ? undefined : 'forms (public link)',
      unchanged: { path: answerPath(fm.id, id), blobOid: null },
    })
    this.#perForm.take(fm.id)
    // Posted in the background: the answer is saved, and a slow chat never holds up the reply.
    if (fm.room) {
      void this.#announce(fm.room, space, fm, id, answers).catch((err) =>
        this.#log(`forms: chat post failed: ${err}`),
      )
    }
    return { id }
  }

  // ── internals ────────────────────────────────────────────────────────

  async #announce(room: string, space: string, fm: FormFrontmatter, id: string, answers: Answers) {
    const preview = fm.questions
      .filter((q) => answers[q.id] !== undefined)
      .slice(0, 3)
      .map(
        (q) =>
          `> ${slackEscape(q.label)}: ${slackEscape(oneLine(displayValue(answers[q.id]), 120))}`,
      )
      .join('\n')
    const url = `${this.#deps.publicUrl}/forms/${encodeURIComponent(space)}/${fm.id}/answers?answer=${id}`
    const text = `New answer to *${slackEscape(fm.title)}*\n${preview}\n<${url}|Open the answer>`
    // A failed post is logged by the rooms; the answer is already saved.
    await this.#deps.rooms.post(room, text)
  }

  async #byLink(link: string): Promise<{ space: string; fm: FormFrontmatter }> {
    if (!LINK.test(link)) throw notFound()
    const found: Array<{ space: string; fm: FormFrontmatter }> = []
    for (const { name } of this.#deps.index.listSpaces()) {
      for (const row of this.#deps.index.listFiles({ space: name, kind: 'form' })) {
        if (row.frontmatter?.link !== link) continue
        // Re-read from Git: a form closed a moment ago counts before the index catches up.
        const id = row.frontmatter?.id
        if (typeof id !== 'string' || row.path !== formPath(id)) continue
        const { fm } = await this.#readForm(name, id)
        if (fm.link === link) found.push({ space: name, fm })
      }
    }
    if (found.length === 1 && found[0]) return found[0]
    // A link is random, so two forms share one only when a file was copied or hand-made in Git.
    // The team's form wins over a copy in someone's personal space; otherwise neither opens.
    const team = found.find((f) => f.space === 'team')
    if (team) return team
    if (found.length > 1) this.#log(`forms: ${found.length} forms share one fill link; refusing it`)
    throw notFound()
  }

  async #readForm(space: string, id: string) {
    if (!isFormId(id)) throw notFound()
    const file = await this.#deps.git.readFile(space, formPath(id)).catch((err) => {
      throw err instanceof HearthError && err.code === 'not_found' ? notFound() : err
    })
    const parsed = FormFrontmatter.safeParse(parseFrontmatter(file.content).data)
    if (!parsed.success || parsed.data.id !== id) {
      throw new HearthError('conflict', 'This form’s file can’t be read; fix it in Git')
    }
    return { fm: parsed.data, content: file.content, blobOid: file.blobOid }
  }

  #answerRows(space: string, id: string) {
    return this.#deps.index.listFiles({
      space,
      kind: 'form-answer',
      prefix: `${FORMS_FOLDER}/${id}/`,
    })
  }

  #answers(space: string, id: string): AnswerRow[] {
    const out: AnswerRow[] = []
    for (const row of this.#answerRows(space, id)) {
      const fm = AnswerFrontmatter.safeParse(row.frontmatter ?? {})
      if (!fm.success || fm.data.form !== id || row.path !== answerPath(id, fm.data.id)) continue
      out.push({
        id: fm.data.id,
        submitted: fm.data.submitted,
        submittedBy: fm.data.submitted_by,
        answers: fm.data.answers as Answers,
      })
    }
    return out.sort((a, b) => b.submitted.localeCompare(a.submitted) || b.id.localeCompare(a.id))
  }

  #summary(space: string, fm: FormFrontmatter): FormSummary {
    const answers = this.#answers(space, fm.id)
    return {
      space,
      id: fm.id,
      title: fm.title,
      access: fm.access,
      open: fm.open,
      answerCount: answers.length,
      lastAnswer: answers[0]?.submitted ?? null,
      updated: fm.updated ?? null,
      updatedBy: fm.updated_by ?? null,
    }
  }

  #view(space: string, fm: FormFrontmatter, blobOid: string): FormView {
    return {
      ...this.#summary(space, fm),
      description: fm.description,
      questions: fm.questions,
      room: fm.room,
      url: `${this.#deps.publicUrl}/f/${fm.link}`,
      created: fm.created ?? null,
      createdBy: fm.created_by ?? null,
      blobOid,
    }
  }

  async #commit(
    space: string,
    author: Author,
    args: {
      changes: Change[]
      verb: string
      title: string
      via: string | undefined
      unchanged: { path: string; blobOid: string | null }
    },
  ): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await this.#deps.git.commit(space, {
          changes: args.changes,
          author,
          message: withVia(
            formatCommitMessage({
              app: 'forms',
              verb: args.verb,
              title: args.title.replace(/"/g, "'"),
            }),
            args.via,
          ),
          unchanged: args.unchanged,
        })
        if (result.status === 'conflict') throw stale()
        break
      } catch (err) {
        if (!(err instanceof HearthError && err.code === 'conflict')) throw err
        // A new answer only clashes with another commit landing at once: try again. A form
        // saved over an old version is stale: the member reloads.
        if (args.verb === 'answer' && attempt < WRITE_ATTEMPTS) continue
        throw args.verb === 'answer' ? err : stale()
      }
    }
    await this.#deps.syncer.afterHeadChanged(space)
  }

  #assertAccess(principal: Principal, space: string) {
    if (!this.#deps.spaces.canAccess(principal, space)) {
      throw new HearthError('forbidden', `You don't have access to the space "${space}"`)
    }
  }

  #iso(): string {
    return this.#now()
      .toISOString()
      .replace(/\.\d+Z$/, 'Z')
  }
}

const PLACEHOLDER_ID = '00000000000000000000000000'
const SUMMARY_SYSTEM = `You summarize the answers a small team's form received, for the people who made the form.
Write short Markdown: a one-sentence overview, then the main themes as bullets, each with roughly how many answers raised it, then anything that stands out (a strong complaint, a request several people made, an outlier). Quote an answer only briefly. Don't invent numbers; counts for choice and rating questions are shown separately, so focus on the written answers. Don't repeat personal details such as emails or phone numbers.`

function formFile(fm: FormFrontmatter): string {
  const data = Object.fromEntries(Object.entries(fm).filter(([, v]) => v !== undefined))
  const lines = [fm.description.trim(), ...fm.questions.map((q) => `- ${q.label}`)].filter(Boolean)
  return `---\n${toYaml(data)}---\n${lines.join('\n')}\n`
}

function columnFor(q: Question): Column {
  if (q.type === 'choice' || q.type === 'dropdown')
    return { type: 'choice', options: q.options ?? [] }
  if (q.type === 'rating') return { type: 'number' }
  if (q.type === 'date') return { type: 'date' }
  return { type: 'text' }
}

function tally(questions: readonly Question[], rows: readonly AnswerRow[]): Tally[] {
  const out: Tally[] = []
  for (const q of questions) {
    const values = rows.map((r) => r.answers[q.id]).filter((v) => v !== undefined)
    if (q.type === 'choice' || q.type === 'dropdown' || q.type === 'multi') {
      const counts = (q.options ?? []).map((option) => ({
        option,
        count: values.filter((v) =>
          Array.isArray(v) ? (v as unknown[]).includes(option) : v === option,
        ).length,
      }))
      out.push({ question: q.id, counts, answered: values.length })
    } else if (q.type === 'rating') {
      const nums = values.filter((v): v is number => typeof v === 'number')
      const average = nums.length
        ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10
        : 0
      out.push({ question: q.id, average, answered: nums.length })
    }
  }
  return out
}

/** A form title as one Files folder name: no slashes or dots that would split it. */
function folderName(title: string): string {
  return (
    title
      .replace(/[/\\]+/g, '-')
      .replace(/^\.+/, '')
      .trim()
      .slice(0, 80) || 'Form'
  )
}

const oneLine = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Slack's three escapes, so answer text can't make links or mentions. */
const slackEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return 'localhost'
  }
}

const notFound = () => new HearthError('not_found', 'No such form')
const stale = () =>
  new HearthError('conflict', 'Someone changed this form at the same time; reload to see it')
