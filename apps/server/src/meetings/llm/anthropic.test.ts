import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it, vi } from 'vitest'
import { HearthError } from '../../errors.js'
import { AnthropicLLM, type MessagesClient } from './anthropic.js'

function message(fields: Partial<Anthropic.Message>): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-5',
    content: [],
    stop_reason: 'end_turn',
    usage: { input_tokens: 120, output_tokens: 45 },
    ...fields,
  } as unknown as Anthropic.Message
}

function client(result: Anthropic.Message | Error) {
  const stream = vi.fn((_params: Anthropic.MessageStreamParams) => ({
    finalMessage: () =>
      result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
  }))
  return { stream, client: { messages: { stream } } satisfies MessagesClient }
}

const REQUEST = {
  model: 'claude-sonnet-5-5',
  system: 'You write meeting notes.',
  messages: [{ role: 'user' as const, content: 'Notes please' }],
}

describe('AnthropicLLM', () => {
  it('streams exactly model, max_tokens, system and messages, with no thinking or sampling', async () => {
    const { stream, client: c } = client(message({ content: [] }))
    await new AnthropicLLM(c).complete(REQUEST)
    await new AnthropicLLM(c).complete({ ...REQUEST, maxTokens: 2_000 })
    expect(stream.mock.calls[0]?.[0]).toEqual({
      model: 'claude-sonnet-5-5',
      max_tokens: 16_000,
      system: 'You write meeting notes.',
      messages: [{ role: 'user', content: 'Notes please' }],
    })
    expect(stream.mock.calls[1]?.[0].max_tokens).toBe(2_000)
  })

  it('concatenates the text blocks and reports token usage', async () => {
    const { client: c } = client(
      message({
        content: [
          { type: 'thinking', thinking: '', signature: 'sig' },
          { type: 'text', text: '## Summary\n', citations: null },
          { type: 'text', text: '- Dana wants SSO\n', citations: null },
        ] as Anthropic.ContentBlock[],
      }),
    )
    expect(await new AnthropicLLM(c).complete(REQUEST)).toEqual({
      text: '## Summary\n- Dana wants SSO\n',
      usage: { input: 120, output: 45 },
    })
  })

  it('maps SDK errors to llm_error and keeps their detail in the log', async () => {
    const headers = new Headers()
    const cases: Array<[Error, RegExp]> = [
      [new Anthropic.RateLimitError(429, {}, 'rate limited', headers), /busy/],
      [new Anthropic.AuthenticationError(401, {}, 'bad key sk-ant-xyz', headers), /API key/],
      [new Anthropic.APIConnectionError({ message: 'ECONNRESET' }), /reach Claude/],
      [new Anthropic.InternalServerError(529, {}, 'overloaded', headers), /failed \(529\)/],
    ]
    for (const [error, message] of cases) {
      const log = vi.fn()
      const { client: c } = client(error)
      const failure = await new AnthropicLLM(c, { log }).complete(REQUEST).catch((e) => e)
      expect(failure).toBeInstanceOf(HearthError)
      expect(failure).toMatchObject({ code: 'llm_error', status: 502 })
      expect(failure.message).toMatch(message)
      expect(failure.message).not.toContain('sk-ant')
      expect(log).toHaveBeenCalledOnce()
    }
  })

  it('rethrows errors that are not from the API', async () => {
    const { client: c } = client(new TypeError('bug'))
    await expect(new AnthropicLLM(c).complete(REQUEST)).rejects.toThrow(TypeError)
  })

  it('treats a refusal as llm_error', async () => {
    const { client: c } = client(message({ stop_reason: 'refusal', content: [] }))
    await expect(new AnthropicLLM(c, { log: () => {} }).complete(REQUEST)).rejects.toMatchObject({
      code: 'llm_error',
    })
  })
})
