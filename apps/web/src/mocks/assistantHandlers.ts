// MSW routes for `/api/assistant` (docs/PLAN-assistant.md) in the demo and in tests: a stand-in
// that searches the demo's docs and answers with links, streamed like the real one. It never
// writes, so the demo's data stays as seeded.

import { type AnyHandler, HttpResponse, http } from 'msw'
import type {
  AssistantEvent,
  AssistantSettings,
  Conversation,
  DisplayMessage,
  PageContext,
  ToolView,
} from '../api/assistant'
import type { FakeRepo, FakeUser } from './fakeRepo'

const FILLER = new Set(
  'about after again also and any are can could did does doc docs find for from have how into its just know last like look make me more most much need next note our over please show should some than that the their them then there these they this what when where which who why will with would you your'.split(
    ' ',
  ),
)

const MODELS = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (fast, recommended)' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (smartest, slower, costs about twice as much)' },
]

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function assistantHandlers(opts: {
  repo: FakeRepo
  principal: (request: Request) => FakeUser | Response
  latencyMs: number
}): AnyHandler[] {
  const { repo, principal } = opts
  const conversations = new Map<string, Conversation & { owner: string }>()
  let settings: AssistantSettings = {
    model: MODELS[0]?.id ?? '',
    monthlyLimitUsd: 0,
    models: MODELS,
    fromEnv: { model: false, monthlyLimitUsd: false },
  }
  let questions = 0

  const answer = (user: FakeUser, text: string): { tool: ToolView; reply: string } => {
    if (/^\s*(add|create|write|delete|move|rename|edit)\b/i.test(text)) {
      return {
        tool: { id: 'demo-0', name: 'list_spaces', kind: 'read', input: {}, status: 'done' },
        reply:
          'This demo only reads, so its sample data stays put. In your own workspace I make the change at once and show Undo; deleting or moving a file waits for your Confirm.',
      }
    }
    const words = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !FILLER.has(w))
    const spaces = ['team', user.handle]
    const seen = new Map<string, { space: string; path: string; title: string; score: number }>()
    for (const word of words) {
      for (const hit of repo.search(word, spaces)) {
        const key = `${hit.space}/${hit.path}`
        const prior = seen.get(key)
        seen.set(key, { ...hit, score: (prior?.score ?? 0) + hit.score })
      }
    }
    const hits = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, 3)
    const query = words.slice(0, 3).join(' ')
    const tool: ToolView = {
      id: 'demo-0',
      name: 'search',
      kind: 'read',
      input: { query },
      status: 'done',
    }
    if (hits.length === 0) {
      return { tool, reply: "I couldn't find anything about that in this workspace." }
    }
    const lines = hits.map((h) => `- [${h.title}](<hearth:${h.space}/${h.path}>)`)
    return { tool, reply: `Here's what I found:\n\n${lines.join('\n')}` }
  }

  return [
    http.get('/api/assistant', () => HttpResponse.json({ name: 'Ask Acme', configured: true })),
    http.get('/api/assistant/conversations', ({ request }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      const mine = [...conversations.values()]
        .filter((c) => c.owner === user.email)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt }))
      return HttpResponse.json({ conversations: mine })
    }),
    http.get('/api/assistant/conversations/:id', ({ request, params }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      const c = conversations.get(String(params.id))
      if (!c || c.owner !== user.email) {
        return HttpResponse.json(
          { error: { code: 'not_found', message: 'No such conversation' } },
          { status: 404 },
        )
      }
      const { owner: _owner, ...view } = c
      return HttpResponse.json(view)
    }),
    http.delete('/api/assistant/conversations/:id', ({ request, params }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      const c = conversations.get(String(params.id))
      if (c?.owner === user.email) conversations.delete(c.id)
      return new HttpResponse(null, { status: 204 })
    }),
    http.post('/api/assistant/conversations/:id/messages', async ({ request, params }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      const body = (await request.json()) as { text: string; context?: PageContext }
      const id = String(params.id)
      const now = new Date().toISOString()
      const c = conversations.get(id) ?? {
        id,
        owner: user.email,
        title: body.text.slice(0, 80),
        createdAt: now,
        updatedAt: now,
        display: [] as DisplayMessage[],
      }
      const { tool, reply } = answer(user, body.text)
      questions += 1
      c.display.push(
        {
          role: 'user',
          text: body.text,
          at: now,
          ...(body.context ? { context: body.context } : {}),
        },
        { role: 'assistant', text: reply, tools: [tool], at: new Date().toISOString() },
      )
      c.updatedAt = new Date().toISOString()
      conversations.set(id, c)
      const events: AssistantEvent[] = [
        { type: 'tool', id: tool.id, name: tool.name, input: tool.input, kind: tool.kind },
        { type: 'tool_result', id: tool.id, isError: false },
        ...(reply.match(/\S+\s*/g) ?? []).map((delta) => ({ type: 'text' as const, delta })),
        { type: 'done' },
      ]
      const step = Math.max(10, Math.min(opts.latencyMs, 40))
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const enc = new TextEncoder()
          for (const event of events) {
            await pause(step)
            controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`))
          }
          controller.close()
        },
      })
      return new HttpResponse(stream, { headers: { 'content-type': 'text/event-stream' } })
    }),
    http.get('/api/assistant/settings', () => HttpResponse.json(settings)),
    http.put('/api/assistant/settings', async ({ request }) => {
      settings = { ...settings, ...((await request.json()) as Partial<AssistantSettings>) }
      return HttpResponse.json(settings)
    }),
    http.get('/api/assistant/usage', ({ request }) => {
      const user = principal(request)
      if (user instanceof Response) return user
      const month = new Date().toISOString().slice(0, 7)
      const members =
        questions === 0
          ? []
          : [
              {
                email: user.email,
                name: user.name,
                questions,
                input: questions * 6000,
                output: questions * 300,
                costUsd: questions * 0.015,
              },
            ]
      return HttpResponse.json({ month, members })
    }),
  ]
}
