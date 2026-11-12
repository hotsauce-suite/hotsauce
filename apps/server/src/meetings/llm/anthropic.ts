import Anthropic from '@anthropic-ai/sdk'
import { HearthError } from '../../errors.js'
import type { LLM, LLMRequest, LLMUsage } from './types.js'

const DEFAULT_MAX_TOKENS = 16_000

/** The slice of the SDK client used here; tests pass a stand-in. */
export interface MessagesClient {
  messages: {
    stream(params: Anthropic.MessageStreamParams): { finalMessage(): Promise<Anthropic.Message> }
  }
}

/**
 * Claude through the Anthropic SDK (LLM_PROVIDER=anthropic). `new Anthropic()` reads
 * ANTHROPIC_API_KEY. Streams so long outputs can't hit the HTTP timeout, and returns the final
 * message's text. SDK errors become `llm_error`; their detail goes to the server log only.
 */
export class AnthropicLLM implements LLM {
  readonly #client: MessagesClient
  readonly #log: (message: string) => void

  constructor(client?: MessagesClient, opts: { log?: (message: string) => void } = {}) {
    this.#client = client ?? new Anthropic()
    this.#log = opts.log ?? console.error
  }

  async complete(req: LLMRequest): Promise<{ text: string; usage: LLMUsage }> {
    const { model, system, messages } = req
    let message: Anthropic.Message
    try {
      message = await this.#client.messages
        .stream({ model, max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS, system, messages })
        .finalMessage()
    } catch (err) {
      if (!(err instanceof Anthropic.APIError)) throw err
      this.#log(`anthropic ${model} failed: ${err.status ?? 'no status'} ${err.message}`)
      throw new HearthError('llm_error', messageFor(err))
    }
    if (message.stop_reason === 'refusal') {
      this.#log(`anthropic ${model} declined: ${JSON.stringify(message.stop_details ?? null)}`)
      throw new HearthError('llm_error', 'Claude declined this request')
    }
    let text = ''
    for (const block of message.content) {
      if (block.type === 'text') text += block.text
    }
    return {
      text,
      usage: { input: message.usage.input_tokens, output: message.usage.output_tokens },
    }
  }
}

function messageFor(err: InstanceType<typeof Anthropic.APIError>): string {
  if (err instanceof Anthropic.RateLimitError) return 'Claude is busy right now; try again shortly'
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError
  ) {
    return 'Claude refused the Anthropic API key'
  }
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach Claude"
  return `Claude request failed${err.status ? ` (${err.status})` : ''}`
}
