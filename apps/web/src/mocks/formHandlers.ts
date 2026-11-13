// MSW routes for Hearth Forms (`/api/forms`, `/api/form/<link>`, `/api/chat-rooms`; ARCHITECTURE
// §21), in memory and shaped like the server's (apps/server/src/forms). The answer check, the CSV
// and the question rules are the format's own. Files in answers are stored in the mock's Files.

import {
  type Answers,
  answersCsv,
  checkAnswers,
  displayValue,
  FormFrontmatter,
  isFormId,
  MAX_ANSWER_FILE_BYTES,
  MAX_ANSWER_FILES,
  newId,
  type Question,
  questionsProblem,
} from '@hearth/format'
import { type AnyHandler, delay, HttpResponse, http } from 'msw'
import type { AnswerRow, FormSummary, FormView, Tally } from '../api/forms'
import type { FakeUser } from './fakeRepo'
import type { FakeFiles } from './fileHandlers'
import { ADA, PRIYA, SAM, seedId } from './seed'

const DAY = 86_400_000
const HOUR = 3_600_000
const LINK = /^[A-Za-z0-9_-]{16,64}$/
const PLACEHOLDER_ID = '00000000000000000000000000'

const error = (status: number, code: string, message: string, details?: unknown) =>
  HttpResponse.json({ error: { code, message, ...(details ? { details } : {}) } }, { status })

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

function randomLink(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18))
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

interface FakeForm {
  space: string
  fm: FormFrontmatter
  blobOid: string
  answers: AnswerRow[]
}

export class FakeForms {
  readonly forms = new Map<string, FakeForm>()
  /** The chat rooms a form can post new answers to (none are ever posted to in the mock). */
  readonly rooms = [{ id: 'pilot', name: '#acme-pilot' }]

  key(space: string, id: string): string {
    return `${space}/${id}`
  }

  get(space: string, id: string): FakeForm | undefined {
    return this.forms.get(this.key(space, id))
  }

  byLink(link: string): FakeForm | undefined {
    return [...this.forms.values()].find((f) => f.fm.link === link)
  }

  add(input: {
    space: string
    title: string
    by: string
    at?: number
    description?: string
    questions?: Question[]
    access?: 'team' | 'public'
    open?: boolean
    id?: string
    link?: string
  }): FakeForm {
    const at = iso(input.at ?? Date.now())
    const fm = FormFrontmatter.parse({
      id: input.id ?? newId(),
      type: 'form',
      title: input.title,
      description: input.description ?? '',
      questions: input.questions ?? [
        { id: 'q1', type: 'short', label: 'Your name', required: true },
      ],
      access: input.access ?? 'team',
      open: input.open ?? true,
      room: null,
      link: input.link ?? randomLink(),
      created: at,
      created_by: input.by,
      updated: at,
      updated_by: input.by,
    })
    const form: FakeForm = { space: input.space, fm, blobOid: newId().toLowerCase(), answers: [] }
    this.forms.set(this.key(input.space, fm.id), form)
    return form
  }

  answer(form: FakeForm, answers: Answers, by: string | null, at = Date.now()): AnswerRow {
    const row: AnswerRow = { id: newId(), submitted: iso(at), submittedBy: by, answers }
    form.answers.push(row)
    form.answers.sort((a, b) => b.submitted.localeCompare(a.submitted) || b.id.localeCompare(a.id))
    return row
  }

  summary(f: FakeForm): FormSummary {
    return {
      space: f.space,
      id: f.fm.id,
      title: f.fm.title,
      access: f.fm.access,
      open: f.fm.open,
      answerCount: f.answers.length,
      lastAnswer: f.answers[0]?.submitted ?? null,
      updated: f.fm.updated ?? null,
      updatedBy: f.fm.updated_by ?? null,
    }
  }

  view(f: FakeForm): FormView {
    return {
      ...this.summary(f),
      description: f.fm.description,
      questions: f.fm.questions,
      room: f.fm.room,
      url: `${window.location.origin}/f/${f.fm.link}`,
      created: f.fm.created ?? null,
      createdBy: f.fm.created_by ?? null,
      blobOid: f.blobOid,
    }
  }
}

const SITES = ['North', 'Harbor', 'Valley']
const FEATURES = ['Docs', 'Meetings', 'Tasks', 'Files', 'Whiteboard']

/** Two team forms with a few answers each. */
export function seedForms(fake: FakeForms, now = Date.now()): void {
  const feedback = fake.add({
    space: 'team',
    id: seedId('FRM', 1),
    link: 'demo-pilot-feedback',
    title: 'Pilot feedback',
    description:
      'Two minutes on how the first weeks of the Acme pilot went. Answers go to the launch team.',
    by: PRIYA.email,
    at: now - 6 * DAY,
    questions: [
      { id: 'name', type: 'short', label: 'Your name', required: true },
      { id: 'email', type: 'email', label: 'Work email', required: false },
      {
        id: 'site',
        type: 'choice',
        label: 'Which site are you at?',
        required: true,
        options: SITES,
      },
      {
        id: 'used',
        type: 'multi',
        label: 'What have you used so far?',
        required: false,
        options: FEATURES,
      },
      {
        id: 'rating',
        type: 'rating',
        label: 'How is the pilot going?',
        required: true,
        scale: 5,
      },
      {
        id: 'blocker',
        type: 'long',
        label: 'What got in your way?',
        help: 'Anything, big or small.',
        required: false,
        show_if: { question: 'site', is: 'Valley' },
      },
      { id: 'best', type: 'long', label: 'What worked best?', required: false },
      {
        id: 'often',
        type: 'dropdown',
        label: 'How often do you open it?',
        required: false,
        options: ['Every day', 'A few times a week', 'Rarely'],
      },
      { id: 'started', type: 'date', label: 'When did you start?', required: false },
      {
        id: 'shot',
        type: 'file',
        label: 'A screenshot of anything confusing',
        required: false,
      },
    ],
  })
  fake.answer(
    feedback,
    {
      name: 'Priya Natarajan',
      email: PRIYA.email,
      site: 'North',
      used: ['Docs', 'Meetings', 'Tasks'],
      rating: 5,
      best: 'Action items from the standup turning into tasks without anyone copying them over.',
      often: 'Every day',
      started: iso(now - 20 * DAY).slice(0, 10),
    },
    PRIYA.email,
    now - 4 * DAY,
  )
  fake.answer(
    feedback,
    {
      name: 'Sam Okafor',
      site: 'Harbor',
      used: ['Docs', 'Files'],
      rating: 4,
      best: 'Sign-in through Okta just worked. Sharing the one-pager by link was handy.',
      often: 'A few times a week',
      started: iso(now - 14 * DAY).slice(0, 10),
    },
    SAM.email,
    now - 2 * DAY - 3 * HOUR,
  )
  fake.answer(
    feedback,
    {
      name: 'Ada Lovelace',
      email: ADA.email,
      site: 'Valley',
      used: ['Meetings', 'Whiteboard'],
      rating: 3,
      blocker: 'Two people still don’t have laptops, so half the team is on email.',
      best: 'The launch plan board made the timeline easy to explain.',
      often: 'A few times a week',
    },
    ADA.email,
    now - 5 * HOUR,
  )

  const lunch = fake.add({
    space: 'team',
    id: seedId('FRM', 2),
    link: 'demo-launch-day-lunch',
    title: 'Launch day lunch',
    description: 'We’re ordering in for the North site walkthrough. Pick by Thursday.',
    by: SAM.email,
    at: now - 3 * DAY,
    questions: [
      { id: 'name', type: 'short', label: 'Your name', required: true },
      {
        id: 'meal',
        type: 'choice',
        label: 'Lunch',
        required: true,
        options: ['Noodle bowls', 'Tacos', 'Salads'],
      },
      { id: 'diet', type: 'short', label: 'Anything we should know?', required: false },
    ],
  })
  fake.answer(lunch, { name: 'Priya', meal: 'Tacos' }, PRIYA.email, now - 2 * DAY)
  fake.answer(
    lunch,
    { name: 'Sam', meal: 'Noodle bowls', diet: 'No peanuts' },
    SAM.email,
    now - DAY,
  )
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

/** The demo has no Claude behind it: a plain digest of the written answers stands in. */
function demoSummary(questions: readonly Question[], rows: readonly AnswerRow[]): string {
  const written = questions.filter((q) => q.type === 'long' || q.type === 'short')
  const bullets: string[] = []
  for (const q of written) {
    const said = rows.map((r) => r.answers[q.id]).filter((v) => typeof v === 'string' && v)
    if (said.length === 0 || q.label.toLowerCase().includes('name')) continue
    const sample = displayValue(said[0])
    const quote = sample.length > 90 ? `${sample.slice(0, 89)}…` : sample
    bullets.push(
      `- **${q.label}** (${said.length} ${said.length === 1 ? 'answer' : 'answers'}): “${quote}”`,
    )
  }
  return [
    `${rows.length} ${rows.length === 1 ? 'person has' : 'people have'} answered so far.`,
    '',
    ...(bullets.length ? bullets : ['- No written answers yet.']),
    '',
    '_This is the demo: the real app asks Claude to summarize the answers._',
  ].join('\n')
}

export interface FormHandlerDeps {
  forms: FakeForms
  files: FakeFiles
  latencyMs: number
  principal: (request: Request) => FakeUser | Response
}

export function formHandlers(deps: FormHandlerDeps): AnyHandler[] {
  const { forms: fake, principal } = deps
  const wait = () => (deps.latencyMs > 0 ? delay(deps.latencyMs) : Promise.resolve())
  const canAccess = (user: FakeUser, space: string) => space === 'team' || space === user.handle
  const forbidden = (space: string) =>
    error(403, 'forbidden', `You don't have access to the space "${space}"`)
  const notFound = () => error(404, 'not_found', 'No such form')

  type Args = { request: Request; user: FakeUser; params: Record<string, unknown>; url: URL }
  const authed =
    (fn: (args: Args) => Response | Promise<Response>) =>
    async ({ request, params }: { request: Request; params: Record<string, unknown> }) => {
      await wait()
      const user = principal(request)
      if (user instanceof Response) return user
      return fn({ request, user, params, url: new URL(request.url) })
    }

  const one = (user: FakeUser, params: Record<string, unknown>): FakeForm | Response => {
    const space = String(params.space)
    const id = String(params.id)
    if (!canAccess(user, space)) return forbidden(space)
    return (isFormId(id) ? fake.get(space, id) : undefined) ?? notFound()
  }

  /** Who is answering: a member, nobody (a public form, signed out), or a refusal. */
  const answering = (request: Request, form: FakeForm): FakeUser | null | Response => {
    const signedIn =
      request.headers.has('x-hearth-dev-user') || request.headers.has('authorization')
    if (!signedIn) {
      return form.fm.access === 'team'
        ? error(401, 'unauthorized', 'Sign in to answer this form')
        : null
    }
    return principal(request)
  }

  return [
    http.get(
      '/api/forms',
      authed(({ user }) => {
        const forms = [...fake.forms.values()]
          .filter((f) => canAccess(user, f.space))
          .map((f) => fake.summary(f))
          .sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''))
        return HttpResponse.json({ forms, canSummarize: true })
      }),
    ),

    http.post(
      '/api/forms',
      authed(async ({ request, user }) => {
        const body = (await request.json().catch(() => ({}))) as { space?: string; title?: string }
        const space = String(body.space ?? '')
        if (!space) return error(400, 'bad_request', 'Choose a space')
        if (!canAccess(user, space)) return forbidden(space)
        const title =
          String(body.title ?? '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 200) || 'Untitled form'
        const form = fake.add({ space, title, by: user.email })
        return HttpResponse.json(fake.view(form))
      }),
    ),

    http.get(
      '/api/forms/:space/:id',
      authed(({ user, params }) => {
        const form = one(user, params)
        return form instanceof Response ? form : HttpResponse.json(fake.view(form))
      }),
    ),

    http.put(
      '/api/forms/:space/:id',
      authed(async ({ request, user, params }) => {
        const form = one(user, params)
        if (form instanceof Response) return form
        const input = (await request.json().catch(() => ({}))) as Record<string, unknown>
        if (input.blobOid !== form.blobOid) {
          return error(
            409,
            'conflict',
            'Someone changed this form at the same time; reload to see it',
          )
        }
        const parsed = FormFrontmatter.safeParse({
          ...form.fm,
          title: String(input.title ?? '')
            .replace(/\s+/g, ' ')
            .trim(),
          description: input.description,
          questions: input.questions,
          access: input.access,
          open: input.open,
          room: input.room,
          updated: iso(Date.now()),
          updated_by: user.email,
        })
        if (!parsed.success) {
          const issue = parsed.error.issues[0]
          return error(400, 'bad_request', `${issue?.path.join('.') ?? 'form'}: ${issue?.message}`)
        }
        const problem = questionsProblem(parsed.data.questions)
        if (problem) return error(400, 'bad_request', problem)
        if (parsed.data.room !== null && !fake.rooms.some((r) => r.id === parsed.data.room)) {
          return error(400, 'bad_request', 'That chat room was removed; pick another')
        }
        form.fm = parsed.data
        form.blobOid = newId().toLowerCase()
        return HttpResponse.json(fake.view(form))
      }),
    ),

    http.delete(
      '/api/forms/:space/:id',
      authed(({ user, params }) => {
        const form = one(user, params)
        if (form instanceof Response) return form
        fake.forms.delete(fake.key(form.space, form.fm.id))
        return new HttpResponse(null, { status: 204 })
      }),
    ),

    http.get(
      '/api/forms/:space/:id/answers',
      authed(({ user, params }) => {
        const form = one(user, params)
        return form instanceof Response ? form : HttpResponse.json({ answers: form.answers })
      }),
    ),

    http.delete(
      '/api/forms/:space/:id/answers/:answer',
      authed(({ user, params }) => {
        const form = one(user, params)
        if (form instanceof Response) return form
        const i = form.answers.findIndex((a) => a.id === String(params.answer))
        if (i === -1) return error(404, 'not_found', 'No such answer')
        form.answers.splice(i, 1)
        return new HttpResponse(null, { status: 204 })
      }),
    ),

    http.get(
      '/api/forms/:space/:id/csv',
      authed(({ user, params }) => {
        const form = one(user, params)
        if (form instanceof Response) return form
        const name = `${form.fm.title.replace(/[^\w .-]+/g, '').trim() || 'answers'}.csv`
        return new HttpResponse(`﻿${answersCsv(form.fm.questions, form.answers)}`, {
          headers: {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': `attachment; filename="${name}"`,
          },
        })
      }),
    ),

    http.post(
      '/api/forms/:space/:id/summary',
      authed(async ({ user, params }) => {
        const form = one(user, params)
        if (form instanceof Response) return form
        const rows = form.answers
        const tallies = tally(form.fm.questions, rows)
        if (rows.length === 0)
          return HttpResponse.json({ summary: null, tallies, read: 0, total: 0 })
        await delay(deps.latencyMs > 0 ? 900 : 0)
        return HttpResponse.json({
          summary: demoSummary(form.fm.questions, rows),
          tallies,
          read: rows.length,
          total: rows.length,
        })
      }),
    ),

    http.get(
      '/api/chat-rooms',
      authed(() => HttpResponse.json({ rooms: fake.rooms, canManage: false })),
    ),

    http.get('/api/form/:link', async ({ request, params }) => {
      await wait()
      const link = String(params.link)
      const form = LINK.test(link) ? fake.byLink(link) : undefined
      if (!form) return notFound()
      const who = answering(request, form)
      if (who instanceof Response) return who
      return HttpResponse.json({
        title: form.fm.title,
        description: form.fm.description,
        questions: form.fm.questions,
        access: form.fm.access,
        open: form.fm.open,
        // Signed out, a public form needs the robot check, which the demo doesn't have.
        canTakeAnswers: form.fm.open && who !== null,
        robotCheck: null,
        maxFiles: MAX_ANSWER_FILES,
        maxFileBytes: MAX_ANSWER_FILE_BYTES,
      })
    }),

    http.post('/api/form/:link', async ({ request, params }) => {
      await wait()
      const link = String(params.link)
      const form = LINK.test(link) ? fake.byLink(link) : undefined
      if (!form) return notFound()
      const who = answering(request, form)
      if (who instanceof Response) return who
      if (!form.fm.open) return error(409, 'conflict', 'This form isn’t taking answers any more')
      if (who === null) return error(503, 'not_configured', 'This form can’t take answers yet')

      let raw: Record<string, unknown> = {}
      const uploads: Array<{ question: string; file: File }> = []
      if ((request.headers.get('content-type') ?? '').startsWith('multipart/form-data')) {
        const body = await request.formData()
        try {
          raw = (JSON.parse(String(body.get('payload') ?? '{}')).answers ?? {}) as Record<
            string,
            unknown
          >
        } catch {
          return error(400, 'bad_request', 'The answers couldn’t be read')
        }
        for (const [key, value] of body.entries()) {
          if (!key.startsWith('file:') || typeof value === 'string') continue
          if (value.size > MAX_ANSWER_FILE_BYTES) {
            return error(413, 'bad_request', 'Each file is at most 10 MB')
          }
          uploads.push({ question: key.slice('file:'.length), file: value })
        }
      } else {
        const body = (await request.json().catch(() => null)) as { answers?: unknown } | null
        if (!body || typeof body.answers !== 'object' || body.answers === null) {
          return error(400, 'bad_request', 'The answers couldn’t be read')
        }
        raw = { ...(body.answers as Record<string, unknown>) }
      }
      if (uploads.length > MAX_ANSWER_FILES) {
        return error(400, 'bad_request', `At most ${MAX_ANSWER_FILES} files`)
      }

      for (const q of form.fm.questions) {
        if (q.type !== 'file') continue
        raw[q.id] = uploads
          .filter((u) => u.question === q.id)
          .map((u) => ({
            id: PLACEHOLDER_ID,
            name: (u.file.name || 'file').slice(0, 200),
            size: u.file.size,
          }))
      }
      const checked = checkAnswers(form.fm.questions, raw)
      if (!checked.ok) {
        return error(400, 'bad_request', 'Some answers need another look', {
          errors: checked.errors,
        })
      }
      const answers = checked.answers
      for (const q of form.fm.questions) {
        if (q.type !== 'file' || answers[q.id] === undefined) continue
        const stored = []
        for (const u of uploads.filter((x) => x.question === q.id)) {
          const file = deps.files.add({
            space: form.space,
            folder: `Forms/${
              form.fm.title
                .replace(/[/\\]+/g, '-')
                .trim()
                .slice(0, 80) || 'Form'
            }`,
            name: u.file.name || 'file',
            mime: u.file.type,
            bytes: new Uint8Array(await u.file.arrayBuffer()),
            by: who.email,
          })
          stored.push({ id: file.id, name: file.name, size: file.bytes.length })
        }
        answers[q.id] = stored
      }
      const row = fake.answer(form, answers, who.email)
      return HttpResponse.json({ id: row.id })
    }),
  ]
}
