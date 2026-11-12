import { HearthError } from '../errors.js'

/** Where filed feedback lives (plan R4): GitHub issues in production, memory in dev and test. */
export interface FeedbackTracker {
  file(issue: {
    title: string
    body: string
    labels: string[]
  }): Promise<{ number: number; url: string }>
  /** Every issue labelled `feedback`, newest first (at most a few hundred). */
  list(): Promise<TrackedIssue[]>
  comments(number: number): Promise<TrackedComment[]>
  comment(number: number, body: string): Promise<void>
  /** Replaces the issue's `status: …` label with this one. */
  setStatus(number: number, status: FeedbackStatus): Promise<void>
}

export interface TrackedIssue {
  number: number
  url: string
  title: string
  body: string
  labels: string[]
  state: 'open' | 'closed'
  createdAt: string
}

export interface TrackedComment {
  body: string
  author: string
  createdAt: string
  /** Written by someone on the team (the repo's owner, an org member or a collaborator). */
  team: boolean
}

export const FEEDBACK_LABEL = 'feedback'

/** The board's columns, as labels (plan "How it fits together"). */
export const FEEDBACK_STATUSES = [
  'new',
  'needs info',
  'needs decision',
  'approved',
  'building',
  'shipped',
  'declined',
] as const
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number]

export const statusLabel = (s: FeedbackStatus) => `status: ${s}`

/** The status an issue's labels say; closed issues without one read as shipped. */
export function statusOf(issue: Pick<TrackedIssue, 'labels' | 'state'>): FeedbackStatus {
  for (const s of FEEDBACK_STATUSES) {
    if (issue.labels.includes(statusLabel(s))) return s
  }
  return issue.state === 'closed' ? 'shipped' : 'new'
}

/** In-memory tracker for development, tests and e2e. */
export class MemoryTracker implements FeedbackTracker {
  readonly issues: (TrackedIssue & { comments: TrackedComment[] })[] = []

  async file(issue: { title: string; body: string; labels: string[] }) {
    const number = this.issues.length + 1
    const url = `https://github.invalid/feedback/issues/${number}`
    this.issues.unshift({
      number,
      url,
      title: issue.title,
      body: issue.body,
      labels: [...issue.labels],
      state: 'open',
      createdAt: new Date().toISOString(),
      comments: [],
    })
    return { number, url }
  }

  async list(): Promise<TrackedIssue[]> {
    return this.issues
      .filter((i) => i.labels.includes(FEEDBACK_LABEL))
      .map(({ comments: _c, ...rest }) => ({ ...rest, labels: [...rest.labels] }))
  }

  async comments(number: number): Promise<TrackedComment[]> {
    return [...this.#get(number).comments]
  }

  async comment(number: number, body: string): Promise<void> {
    this.#get(number).comments.push({
      body,
      author: 'hearth-bot',
      createdAt: new Date().toISOString(),
      team: true,
    })
  }

  async setStatus(number: number, status: FeedbackStatus): Promise<void> {
    const issue = this.#get(number)
    issue.labels = [...issue.labels.filter((l) => !l.startsWith('status: ')), statusLabel(status)]
    issue.state = status === 'shipped' || status === 'declined' ? 'closed' : 'open'
  }

  /** Test hook: the team asks a question, as the daily review would. */
  ask(number: number, question: string, opts: { author?: string; team?: boolean } = {}): void {
    const issue = this.#get(number)
    issue.comments.push({
      body: question,
      author: opts.author ?? 'reviewer',
      createdAt: new Date().toISOString(),
      team: opts.team ?? true,
    })
    issue.labels = [
      ...issue.labels.filter((l) => !l.startsWith('status: ')),
      statusLabel('needs info'),
    ]
  }

  #get(number: number) {
    const issue = this.issues.find((i) => i.number === number)
    if (!issue) throw new HearthError('not_found', 'No such feedback')
    return issue
  }
}

/** GitHub issues through the REST API (GraphQL isn't needed for anything here). */
export class GitHubTracker implements FeedbackTracker {
  readonly #repo: string
  readonly #token: string
  readonly #fetch: typeof fetch
  readonly #api: string

  constructor(opts: { repo: string; token: string; fetch?: typeof fetch; apiUrl?: string }) {
    this.#repo = opts.repo
    this.#token = opts.token
    this.#fetch = opts.fetch ?? fetch
    this.#api = (opts.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '')
  }

  async file(issue: { title: string; body: string; labels: string[] }) {
    const created = await this.#call<{ number: number; html_url: string }>('POST', '/issues', issue)
    return { number: created.number, url: created.html_url }
  }

  async list(): Promise<TrackedIssue[]> {
    const out: TrackedIssue[] = []
    for (let page = 1; page <= 3; page++) {
      const batch = await this.#call<GitHubIssue[]>(
        'GET',
        `/issues?labels=${FEEDBACK_LABEL}&state=all&sort=created&direction=desc&per_page=100&page=${page}`,
      )
      for (const i of batch) {
        if (i.pull_request) continue
        out.push({
          number: i.number,
          url: i.html_url,
          title: i.title,
          body: i.body ?? '',
          labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name)),
          state: i.state === 'closed' ? 'closed' : 'open',
          createdAt: i.created_at,
        })
      }
      if (batch.length < 100) break
    }
    return out
  }

  async comments(number: number): Promise<TrackedComment[]> {
    const out: TrackedComment[] = []
    for (let page = 1; page <= 5; page++) {
      const batch = await this.#call<GitHubComment[]>(
        'GET',
        `/issues/${number}/comments?per_page=100&page=${page}`,
      )
      for (const c of batch) {
        out.push({
          body: c.body ?? '',
          author: c.user?.login ?? '',
          createdAt: c.created_at,
          team: c.user?.type !== 'Bot' && TEAM_ASSOCIATIONS.has(c.author_association ?? ''),
        })
      }
      if (batch.length < 100) break
    }
    return out
  }

  async comment(number: number, body: string): Promise<void> {
    await this.#call('POST', `/issues/${number}/comments`, { body })
  }

  async setStatus(number: number, status: FeedbackStatus): Promise<void> {
    const current = await this.#call<{ name: string }[]>('GET', `/issues/${number}/labels`)
    for (const l of current) {
      if (l.name.startsWith('status: ') && l.name !== statusLabel(status)) {
        await this.#call('DELETE', `/issues/${number}/labels/${encodeURIComponent(l.name)}`)
      }
    }
    await this.#call('POST', `/issues/${number}/labels`, { labels: [statusLabel(status)] })
  }

  async #call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await this.#fetch(`${this.#api}/repos/${this.#repo}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.#token}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'hotsauce-feedback',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    } catch (err) {
      console.error(`feedback: GitHub ${method} ${path} failed: ${String(err)}`)
      throw new HearthError('host_error', "Couldn't reach GitHub")
    }
    if (!res.ok) {
      console.error(`feedback: GitHub ${method} ${path} → ${res.status}`)
      throw new HearthError('host_error', `GitHub refused the feedback request (${res.status})`)
    }
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }
}

/** Comments from these count as the team's; anyone else's are ignored by the app. */
const TEAM_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

interface GitHubComment {
  body?: string
  user?: { login: string; type?: string }
  created_at: string
  author_association?: string
}

interface GitHubIssue {
  number: number
  html_url: string
  title: string
  body?: string | null
  labels: (string | { name: string })[]
  state: string
  created_at: string
  pull_request?: unknown
}
