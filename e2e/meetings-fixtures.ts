import type { APIRequestContext, Page } from '@playwright/test'
import { test as base, expect, HearthApi, signIn, uid } from './fixtures'

export { expect }

/**
 * A member of their own for one test. Meetings land in the member's personal space, so a fresh
 * member per test keeps meetings, the list and chat retrieval apart across workers and runs.
 */
export interface Member {
  email: string
  name: string
  personal: string
  team: string
  api: HearthApi
  /** Authenticated as the member via the dev-auth header, for routes HearthApi doesn't wrap. */
  request: APIRequestContext
}

interface MeetingsFixtures {
  /** A fresh member, with the page signed in as them. */
  member: Member
  /** Another fresh member, not signed in anywhere: an API client only. */
  newMember: () => Promise<Member>
}

export const test = base.extend<MeetingsFixtures>({
  // The page signs in as `member`, not as the worker's shared user.
  signedIn: false,

  newMember: async ({ playwright, baseURL }, use) => {
    const contexts: APIRequestContext[] = []
    await use(async () => {
      const email = `meet-${uid()}@example.test`
      const request = await playwright.request.newContext({
        ...(baseURL ? { baseURL } : {}),
        extraHTTPHeaders: { 'x-hearth-dev-user': email },
      })
      contexts.push(request)
      const api = new HearthApi(request, email)
      // The first authenticated request also provisions the personal space.
      const { principal, spaces } = await api.me()
      const team = spaces.find((s) => s.kind === 'team')
      const personal = spaces.find((s) => s.kind === 'personal')
      if (!team || !personal) throw new Error(`/api/me returned spaces ${JSON.stringify(spaces)}`)
      return { email, name: principal.name, personal: personal.name, team: team.name, api, request }
    })
    await Promise.all(contexts.map((c) => c.dispose()))
  },

  member: async ({ page, newMember }, use) => {
    const member = await newMember()
    await signIn(page, member.email)
    await use(member)
  },
})

/** The live page's id, from `/meetings/live/:id`. */
export function liveSessionId(page: Page): string {
  const match = new URL(page.url()).pathname.match(/^\/meetings\/live\/([^/]+)$/)
  if (!match?.[1]) throw new Error(`not a live meeting URL: ${page.url()}`)
  return decodeURIComponent(match[1])
}

/** Splits the current `/meetings/:space/<path>` URL back into space and path. */
export function parseMeetingUrl(url: string): { space: string; path: string } {
  const match = new URL(url).pathname.match(/^\/meetings\/([^/]+)\/(.+)$/)
  if (!match?.[1] || !match[2]) throw new Error(`not a meeting note URL: ${url}`)
  return {
    space: decodeURIComponent(match[1]),
    path: match[2].split('/').map(decodeURIComponent).join('/'),
  }
}

/** The transcript file beside a meeting note. */
export function transcriptPath(notePath: string): string {
  return notePath.replace(/\.md$/, '.transcript.md')
}

/** Transcript segments from the microphone track, in whichever live transcript view shows. */
export function meSegment(page: Page, text?: string) {
  const segment = page.locator('[data-testid="transcript-segment"][data-track="me"]')
  return text === undefined ? segment : segment.filter({ hasText: text })
}

/**
 * From `/meetings/start` (already open): Mic only, wait for the audio check, Start. Returns the
 * session id once the live page shows it recording.
 */
export async function startMicOnly(page: Page): Promise<string> {
  await page.getByTestId('capture-mic-only').click()
  // The fake device plays a tone, so sound arrives well inside the 3 s check.
  await expect(page.getByTestId('audio-check')).toHaveAttribute('data-state', 'ok', {
    timeout: 5_000,
  })
  await page.getByTestId('start-recording').click()
  await page.waitForURL(/\/meetings\/live\/[^/]+$/)
  await expect(page.getByTestId('recording-indicator')).toHaveAttribute('data-state', 'recording')
  return liveSessionId(page)
}

/** Types at the end of the live notepad (a CodeMirror editor). */
export async function typeNotes(page: Page, text: string): Promise<void> {
  const editor = page.getByTestId('live-notepad').getByTestId('editor-content')
  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(text)
}

/** `GET /api/meetings/sessions/:id` as `member`. */
export async function getSession(
  member: Member,
  id: string,
): Promise<{
  state: string
  rawNotes: string
  segments: Array<{ track: string; text: string; final: boolean }>
}> {
  const res = await member.request.get(`/api/meetings/sessions/${encodeURIComponent(id)}`)
  if (!res.ok()) throw new Error(`${res.status()} from ${res.url()}: ${await res.text()}`)
  return res.json()
}

export interface ChatReply {
  answer: string
  citations: Array<{ space: string; path: string; line: number; text: string }>
}

/** The page's next `POST /api/meetings/chat` answer. Start waiting before asking. */
export async function waitForChat(page: Page): Promise<ChatReply> {
  const res = await page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/meetings/chat' && r.request().method() === 'POST',
  )
  expect(res.ok()).toBe(true)
  return res.json()
}

/**
 * A note split at its frontmatter fences. The frontmatter stays YAML text: the specs match its
 * `key: value` lines rather than pull a YAML parser into e2e.
 */
export function splitNote(content: string): { frontmatter: string; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/)
  if (!match?.[1]) throw new Error(`no frontmatter in:\n${content}`)
  return { frontmatter: match[1], body: content.slice(match[0].length) }
}

/** `ai_ranges` as Hearth writes it, a flow sequence of 1-based `[first, last]` body lines. */
export function aiRangesOf(frontmatter: string): Array<[number, number]> {
  const value = frontmatter.match(/^ai_ranges: (\[.*\])$/m)?.[1]
  if (!value) throw new Error(`no flow-style ai_ranges in:\n${frontmatter}`)
  return JSON.parse(value)
}

/** The 1-based body line that is exactly `text`, or 0. */
export function bodyLineOf(body: string, text: string): number {
  return body.split('\n').indexOf(text) + 1
}
