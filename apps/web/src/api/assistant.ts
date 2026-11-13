// Client for `/api/assistant` (docs/PLAN-assistant.md). Answers stream as Server-Sent Events.

import { apiUrl, getAuthHeaders, HearthApiError, request, toApiError } from './client'

export interface AssistantInfo {
  name: string
  configured: boolean
}

export interface PageContext {
  space: string
  path: string
  title: string
}

export type ToolStatus = 'running' | 'done' | 'error' | 'waiting' | 'confirmed' | 'undone'

export interface ToolView {
  id: string
  name: string
  kind: 'read' | 'write' | 'confirm'
  input: unknown
  status: ToolStatus
  undo?: string
}

export interface DisplayMessage {
  role: 'user' | 'assistant'
  text: string
  context?: PageContext
  tools?: ToolView[]
  at: string
}

export interface ConversationSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

export interface Conversation extends ConversationSummary {
  display: DisplayMessage[]
}

export type AssistantEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; id: string; name: string; input: unknown; kind: ToolView['kind'] }
  | { type: 'tool_result'; id: string; isError: boolean; undo?: string }
  | { type: 'confirm'; id: string; name: string; input: unknown }
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface MemberUsage {
  email: string
  name: string
  questions: number
  input: number
  output: number
  costUsd: number
}

export interface AssistantSettings {
  model: string
  monthlyLimitUsd: number
  models: Array<{ id: string; label: string }>
  /** Set in the server's environment, which wins: shown locked. */
  fromEnv: { model: boolean; monthlyLimitUsd: boolean }
}

const base = '/api/assistant'
const conv = (id: string) => `${base}/conversations/${encodeURIComponent(id)}`

export const assistantApi = {
  info: () => request<AssistantInfo>(base),
  list: () => request<{ conversations: ConversationSummary[] }>(`${base}/conversations`),
  get: (id: string) => request<Conversation>(conv(id)),
  remove: (id: string) => request<void>(conv(id), { method: 'DELETE' }),
  confirm: (id: string, toolId: string) =>
    request<{ isError: boolean; text: string }>(`${conv(id)}/confirm`, {
      method: 'POST',
      json: { toolId },
    }),
  undo: (undoId: string) =>
    request<{ restored: string[] }>(`${base}/undo/${encodeURIComponent(undoId)}`, {
      method: 'POST',
    }),
  usage: (month?: string) =>
    request<{ month: string; members: MemberUsage[] }>(`${base}/usage`, { query: { month } }),
  settings: () => request<AssistantSettings>(`${base}/settings`),
  saveSettings: (patch: { model?: string; monthlyLimitUsd?: number }) =>
    request<AssistantSettings>(`${base}/settings`, { method: 'PUT', json: patch }),
}

/** A new conversation's id (the client picks it, so the first message can create it). */
export function newConversationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return `c${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Sends one message and calls `onEvent` for each event as it arrives. Resolves when the answer
 * ends; a refusal before the answer starts (no key, over the limit) throws a HearthApiError.
 */
export async function askAssistant(
  conversationId: string,
  body: { text: string; context?: PageContext; tz?: string },
  onEvent: (event: AssistantEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response
  try {
    res = await fetch(apiUrl(`${conv(conversationId)}/messages`), {
      method: 'POST',
      headers: { ...(await getAuthHeaders()), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    })
  } catch (err) {
    if (signal?.aborted) return
    throw new HearthApiError('network', 'Could not reach the server', 0, err)
  }
  if (!res.ok || !res.body) throw await toApiError(res)
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  let finished = false
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += value
      let end = buffer.indexOf('\n\n')
      while (end !== -1) {
        const event = parseEvent(buffer.slice(0, end))
        buffer = buffer.slice(end + 2)
        if (event) {
          if (event.type === 'done' || event.type === 'error') finished = true
          onEvent(event)
        }
        end = buffer.indexOf('\n\n')
      }
    }
  } catch (err) {
    if (signal?.aborted) return
    throw err
  }
  if (!finished && !signal?.aborted) {
    throw new HearthApiError('network', 'The answer was cut off. Ask again.', 0)
  }
}

function parseEvent(block: string): AssistantEvent | null {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n')
  if (data === '') return null
  try {
    return JSON.parse(data) as AssistantEvent
  } catch {
    return null
  }
}
