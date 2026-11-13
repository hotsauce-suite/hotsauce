import type Anthropic from '@anthropic-ai/sdk'
import {
  type AssistantModel,
  type AssistantUsage,
  addUsage,
  type ContentBlockParam,
  type MessageParam,
  NO_USAGE,
} from './model.js'
import type { Toolbox, ToolKind } from './toolbox.js'

/** The most model turns one question may take before the assistant stops and says so. */
export const MAX_TURNS = 20

/** What the panel sees while the assistant works (Server-Sent Events, one per event). */
export type AssistantEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; id: string; name: string; input: unknown; kind: ToolKind }
  | { type: 'tool_result'; id: string; isError: boolean; undo?: string }
  | { type: 'confirm'; id: string; name: string; input: unknown }
  | { type: 'done'; usage: AssistantUsage }
  | { type: 'error'; message: string }

/** Records what a write tool call changed, so it can be undone; returns an undo id or null. */
export interface WriteTracker {
  around<T>(run: () => Promise<T>): Promise<{ result: T; undo: string | null }>
}

export interface AgentRun {
  model: AssistantModel
  modelId: string
  toolbox: Toolbox
  system: string
  /** The conversation so far, in API shape, ending with the member's new message. */
  messages: MessageParam[]
  emit: (event: AssistantEvent) => void
  writes?: WriteTracker
  signal?: AbortSignal
  /**
   * Filled in as the loop goes, so a caller whose run stops part-way (Stop, an API error) can
   * still record the tokens used and keep the complete turns.
   */
  progress?: AgentProgress
}

export interface AgentProgress {
  added: MessageParam[]
  usage: AssistantUsage
}

export const WAITING_FOR_CONFIRM =
  'Not done yet: this waits for the member to click Confirm in the panel. Tell them in one sentence what will happen when they confirm, and stop.'

/**
 * The loop: a model turn, then every tool call it made (in parallel), fed back, until the model
 * answers without a tool or MAX_TURNS is reached. Returns the messages it added (assistant turns
 * and tool results, in order), so the caller can keep the conversation.
 */
export async function runAgent(run: AgentRun): Promise<{
  added: MessageParam[]
  usage: AssistantUsage
  stoppedEarly: boolean
}> {
  const { model, toolbox, emit } = run
  const messages = [...run.messages]
  const progress = run.progress ?? { added: [], usage: NO_USAGE }
  const added = progress.added
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    run.signal?.throwIfAborted()
    const reply = await model.turn(
      {
        model: run.modelId,
        system: run.system,
        messages,
        tools: toolbox.tools,
        ...(run.signal ? { signal: run.signal } : {}),
      },
      (delta) => emit({ type: 'text', delta }),
    )
    progress.usage = addUsage(progress.usage, reply.usage)
    const assistant: MessageParam = { role: 'assistant', content: reply.content }
    messages.push(assistant)
    added.push(assistant)
    const calls = reply.content.filter(
      (b): b is Anthropic.Beta.BetaToolUseBlockParam => b.type === 'tool_use',
    )
    if (reply.stopReason !== 'tool_use' || calls.length === 0) {
      return { added, usage: progress.usage, stoppedEarly: false }
    }
    // Reads run in parallel; writes one at a time, so each one's Undo covers only its own files.
    let writing: Promise<unknown> = Promise.resolve()
    const results = await Promise.all(
      calls.map((call) => {
        if (toolbox.kind(call.name) === 'read') return runCall(run, call)
        const next = writing.then(() => runCall(run, call))
        writing = next.catch(() => {})
        return next
      }),
    )
    const user: MessageParam = { role: 'user', content: results }
    messages.push(user)
    added.push(user)
  }
  const note = `\n\nI stopped after ${MAX_TURNS} steps. Ask me to keep going if you want me to continue.`
  emit({ type: 'text', delta: note })
  added.push({ role: 'assistant', content: [{ type: 'text', text: note.trim() }] })
  return { added, usage: progress.usage, stoppedEarly: true }
}

async function runCall(
  run: AgentRun,
  call: Anthropic.Beta.BetaToolUseBlockParam,
): Promise<ContentBlockParam> {
  const { toolbox, emit } = run
  const kind = toolbox.kind(call.name)
  emit({ type: 'tool', id: call.id, name: call.name, input: call.input, kind })
  if (kind === 'confirm') {
    emit({ type: 'confirm', id: call.id, name: call.name, input: call.input })
    emit({ type: 'tool_result', id: call.id, isError: false })
    return { type: 'tool_result', tool_use_id: call.id, content: WAITING_FOR_CONFIRM }
  }
  let outcome: { text: string; isError: boolean }
  let undo: string | null = null
  if (kind === 'write' && run.writes) {
    const tracked = await run.writes.around(() => toolbox.call(call.name, call.input))
    outcome = tracked.result
    undo = outcome.isError ? null : tracked.undo
  } else {
    outcome = await toolbox.call(call.name, call.input)
  }
  emit({
    type: 'tool_result',
    id: call.id,
    isError: outcome.isError,
    ...(undo ? { undo } : {}),
  })
  return {
    type: 'tool_result',
    tool_use_id: call.id,
    content: outcome.text,
    ...(outcome.isError ? { is_error: true } : {}),
  }
}
