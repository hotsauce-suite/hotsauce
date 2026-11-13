import { useSyncExternalStore } from 'react'

/** Whether the assistant panel is open, and a question waiting to be asked when it opens. */
interface AssistantState {
  open: boolean
  /** Set by `openAssistant(prompt)`; the panel takes it and clears it. */
  prompt: string | null
  /** Bumped each time a prompt is handed over, so the same text twice still sends twice. */
  seq: number
}

let state: AssistantState = { open: false, prompt: null, seq: 0 }
const listeners = new Set<() => void>()

function set(next: Partial<AssistantState>): void {
  state = { ...state, ...next }
  for (const l of listeners) l()
}

/** Opens the panel; with `prompt`, asks it in a new conversation (Command-K's "Ask" item). */
export function openAssistant(prompt?: string): void {
  const text = prompt?.trim()
  set(text ? { open: true, prompt: text, seq: state.seq + 1 } : { open: true })
}

export function closeAssistant(): void {
  set({ open: false })
}

export function toggleAssistant(): void {
  set({ open: !state.open })
}

/** The panel calls this once it has started the handed-over question. */
export function takePrompt(): string | null {
  const { prompt } = state
  if (prompt !== null) state = { ...state, prompt: null }
  return prompt
}

export function useAssistantState(): AssistantState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
  )
}
