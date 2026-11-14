import { describe, expect, it } from 'vitest'
import { FakeLLM } from '../meetings/index.js'
import { Clarifier } from './clarify.js'
import { MAX_SCREENSHOT_BYTES, MAX_SCREENSHOTS, sniffImage } from './screenshots.js'
import { Feedback } from './service.js'
import { type FeedbackTracker, GitHubTracker, MemoryTracker } from './tracker.js'

// docs/PLAN-feedback-screenshots.md, S1–S4.

const ALICE = {
  userId: 'u1',
  email: 'alice@example.test',
  name: 'Alice',
  handle: 'alice',
  isAdmin: false,
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const GIF = new TextEncoder().encode('GIF89a....')
const WEBP = new Uint8Array([
  ...new TextEncoder().encode('RIFF'),
  0,
  0,
  0,
  0,
  ...new TextEncoder().encode('WEBPVP8 '),
])

function make<T extends FeedbackTracker = MemoryTracker>(
  tracker: T = new MemoryTracker() as unknown as T,
) {
  const llm = new FakeLLM(() => {
    throw new Error('unused')
  })
  const feedback = new Feedback({
    clarifier: new Clarifier({ llm, model: 'm' }),
    tracker,
    secret: 'x'.repeat(32),
  })
  return { tracker, feedback }
}

const base = { kind: 'bug' as const, text: 'The chart is blank', answers: [], context: {} }

describe('sniffImage (S4)', () => {
  it.each([
    [PNG, 'png'],
    [JPEG, 'jpg'],
    [GIF, 'gif'],
    [WEBP, 'webp'],
  ])('reads the real type from the bytes', (bytes, ext) => {
    expect(sniffImage(bytes)?.ext).toBe(ext)
  })

  it('refuses anything else, whatever it claims to be', () => {
    expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(
      null,
    )
    expect(sniffImage(new TextEncoder().encode('%PDF-1.7'))).toBe(null)
    expect(sniffImage(new Uint8Array())).toBe(null)
  })
})

describe('MemoryTracker.upload (S1)', () => {
  it('keeps the file and gives a URL to show it', async () => {
    const tracker = new MemoryTracker()
    const { url } = await tracker.upload('screenshots/2026-11/a.png', PNG, 'Feedback screenshot')
    expect(url).toBe('https://github.invalid/feedback/blob/main/screenshots/2026-11/a.png?raw=true')
    expect(tracker.uploads).toEqual([
      { path: 'screenshots/2026-11/a.png', bytes: PNG, message: 'Feedback screenshot' },
    ])
  })
})

describe('GitHubTracker.upload (S1)', () => {
  it('PUTs the file with the Contents API and returns its raw view', async () => {
    const calls: { method: string; url: string; body: { message: string; content: string } }[] = []
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ method: init.method ?? 'GET', url, body: JSON.parse(String(init.body)) })
      return Response.json(
        {
          content: {
            path: 'screenshots/2026-11/a.png',
            html_url: 'https://github.com/o/r/blob/main/screenshots/2026-11/a.png',
          },
        },
        { status: 201 },
      )
    }) as unknown as typeof fetch
    const tracker = new GitHubTracker({ repo: 'o/r', token: 'tkn', fetch: fakeFetch })
    const { url } = await tracker.upload('screenshots/2026-11/a.png', PNG, 'Feedback screenshot')
    expect(url).toBe('https://github.com/o/r/blob/main/screenshots/2026-11/a.png?raw=true')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('PUT')
    expect(calls[0]?.url).toBe(
      'https://api.github.com/repos/o/r/contents/screenshots/2026-11/a.png',
    )
    expect(calls[0]?.body.message).toBe('Feedback screenshot')
    expect(Buffer.from(calls[0]?.body.content ?? '', 'base64')).toEqual(Buffer.from(PNG))
  })
})

describe('submitting with screenshots (S2, S3)', () => {
  it('uploads each picture before filing and shows them in the issue', async () => {
    const tracker = new MemoryTracker()
    const order: string[] = []
    const upload = tracker.upload.bind(tracker)
    const file = tracker.file.bind(tracker)
    tracker.upload = async (...args) => {
      order.push('upload')
      return upload(...args)
    }
    tracker.file = async (...args) => {
      order.push('file')
      return file(...args)
    }
    const { feedback } = make(tracker)
    await feedback.submit(ALICE, { ...base, screenshots: [PNG, JPEG] })
    expect(order).toEqual(['upload', 'upload', 'file'])
    expect(tracker.uploads[0]?.message).toBe('Feedback screenshot [skip ci]')
    const paths = tracker.uploads.map((u) => u.path)
    expect(paths[0]).toMatch(/^screenshots\/\d{4}-\d{2}\/[A-Za-z0-9_-]{10,}\.png$/)
    expect(paths[1]).toMatch(/\.jpg$/)
    expect(paths[0]).not.toBe(paths[1])
    const body = tracker.issues[0]?.body ?? ''
    expect(body).toContain('### Screenshots')
    expect(body).toContain(
      `![Screenshot 1](https://github.invalid/feedback/blob/main/${paths[0]}?raw=true)`,
    )
    expect(body).toContain(
      `![Screenshot 2](https://github.invalid/feedback/blob/main/${paths[1]}?raw=true)`,
    )
  })

  it('files without pictures as before', async () => {
    const { tracker, feedback } = make()
    await feedback.submit(ALICE, base)
    expect(tracker.issues[0]?.body).not.toContain('Screenshot')
    expect(tracker.uploads).toEqual([])
  })

  it('still files, with a note, when the token cannot write files (S3)', async () => {
    const fakeFetch = (async (url: string, init: RequestInit) => {
      if (url.includes('/contents/')) return new Response('nope', { status: 403 })
      if (url.endsWith('/issues') && init.method === 'POST') {
        return Response.json({ number: 3, html_url: 'https://github.com/o/r/issues/3' })
      }
      return Response.json({})
    }) as unknown as typeof fetch
    const filed: string[] = []
    const tracker = new GitHubTracker({ repo: 'o/r', token: 't', fetch: fakeFetch })
    const fileIssue = tracker.file.bind(tracker)
    tracker.file = async (issue) => {
      filed.push(issue.body)
      return fileIssue(issue)
    }
    const { feedback } = make(tracker)
    const result = await feedback.submit(ALICE, { ...base, screenshots: [PNG, PNG] })
    expect(result.number).toBe(3)
    expect(filed[0]).toContain(
      "2 screenshot(s) couldn't be saved: the feedback token needs Contents read and write",
    )
    expect(filed[0]).toContain('The chart is blank')
    expect(filed[0]).not.toContain('![Screenshot')
  })

  it('still files when an upload fails some other way', async () => {
    const tracker = new MemoryTracker()
    let n = 0
    const upload = tracker.upload.bind(tracker)
    tracker.upload = async (...args) => {
      if (n++ === 0) throw new Error('boom')
      return upload(...args)
    }
    const { feedback } = make(tracker)
    await feedback.submit(ALICE, { ...base, screenshots: [PNG, GIF] })
    const body = tracker.issues[0]?.body ?? ''
    expect(body).toContain("1 screenshot(s) couldn't be saved.")
    expect(body).toContain('![Screenshot 1]')
    expect(body).not.toContain('![Screenshot 2]')
  })

  it('refuses more than three, non-images and oversized pictures (S4)', async () => {
    const { tracker, feedback } = make()
    const big = new Uint8Array(MAX_SCREENSHOT_BYTES + 1)
    big.set(PNG)
    for (const screenshots of [
      Array.from({ length: MAX_SCREENSHOTS + 1 }, () => PNG),
      [new TextEncoder().encode('<svg/>')],
      [big],
    ]) {
      await expect(feedback.submit(ALICE, { ...base, screenshots })).rejects.toMatchObject({
        code: 'bad_request',
      })
    }
    expect(tracker.issues).toEqual([])
  })
})
