// MSW route for `/api/slides/draft` (docs/PLAN-slides.md R9): the live demo has no AI, so it
// turns the doc's `##` sections into a deck with a title slide and short speaker notes.

import { type AnyHandler, delay, HttpResponse, http } from 'msw'
import type { FakeUser } from './fakeRepo'

/** A deck from a doc's headings: what a real draft looks like, without a model. */
export function demoDeck(title: string, markdown: string): string {
  const sections: { heading: string; lines: string[] }[] = []
  for (const line of markdown.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n')) {
    const heading = /^##\s+(.+)/.exec(line)
    if (heading?.[1]) sections.push({ heading: heading[1].trim(), lines: [] })
    else if (sections.length > 0 && /^\s*[-*]\s+\S/.test(line))
      sections.at(-1)?.lines.push(line.trim())
  }
  const slides = [`# ${title}\n\nNotes: Say what this deck is for and what you want from the room.`]
  for (const { heading, lines } of sections) {
    const bullets = lines.slice(0, 5).join('\n') || `- The key point about ${heading.toLowerCase()}`
    slides.push(`## ${heading}\n\n${bullets}\n\nNotes: Walk through ${heading.toLowerCase()}.`)
  }
  if (sections.length === 0) {
    slides.push(`## The idea\n\n- What it is\n- Why now\n- What we need\n\nNotes: Keep it short.`)
  }
  return `${slides.join('\n\n---\n\n')}\n`
}

export function slideHandlers(opts: {
  principal: (request: Request) => FakeUser | Response
  latencyMs: number
}): AnyHandler[] {
  return [
    http.post('/api/slides/draft', async ({ request }) => {
      const user = opts.principal(request)
      if (user instanceof Response) return user
      const { title, markdown } = (await request.json()) as { title: string; markdown: string }
      // Long enough to see "Drafting slides…", as a real model takes a while.
      await delay(Math.max(opts.latencyMs, 800))
      return HttpResponse.json({ markdown: demoDeck(title, markdown) })
    }),
  ]
}
