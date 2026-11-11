export interface LLMMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface LLMRequest {
  model: string
  system: string
  messages: LLMMessage[]
  maxTokens?: number
}

export interface LLMUsage {
  input: number
  output: number
}

export interface LLM {
  complete(req: LLMRequest): Promise<{ text: string; usage: LLMUsage }>
}
