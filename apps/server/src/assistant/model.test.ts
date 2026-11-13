import type Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { HearthError } from '../errors.js'
import { AnthropicAssistantModel, type BetaMessagesClient } from './model.js'
import { estimateCostUsd } from './pricing.js'

function client(
  message: Partial<Anthropic.Beta.BetaMessage>,
  seen: unknown[] = [],
): BetaMessagesClient {
  return {
    beta: {
      messages: {
        stream(params) {
          seen.push(params)
          let onText: (d: string) => void = () => {}
          return {
            on(_event: 'text', listener: (d: string) => void) {
              onText = listener
            },
            async finalMessage() {
              onText('Hi')
              return {
                content: [{ type: 'text', text: 'Hi', citations: null }],
                stop_reason: 'end_turn',
                stop_details: null,
                usage: {
                  input_tokens: 10,
                  output_tokens: 2,
                  cache_read_input_tokens: 5,
                  cache_creation_input_tokens: 3,
                },
                ...message,
              } as Anthropic.Beta.BetaMessage
            },
          }
        },
      },
    },
  }
}

describe('AnthropicAssistantModel', () => {
  it('streams with caching and refusal fallbacks, and reports usage', async () => {
    const seen: Array<Record<string, unknown>> = []
    const text: string[] = []
    const turn = await new AnthropicAssistantModel(client({}, seen)).turn(
      {
        model: 'claude-sonnet-5-5',
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
      },
      (d) => text.push(d),
    )
    expect(text).toEqual(['Hi'])
    expect(turn.usage).toEqual({ input: 10, output: 2, cacheRead: 5, cacheWrite: 3 })
    expect(seen[0]).toMatchObject({
      model: 'claude-sonnet-5-5',
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01'],
      cache_control: { type: 'ephemeral' },
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
    })
  })

  it('turns a refusal of the whole chain into llm_error', async () => {
    const model = new AnthropicAssistantModel(client({ stop_reason: 'refusal' }), { log: () => {} })
    await expect(
      model.turn({ model: 'm', system: '', messages: [], tools: [] }, () => {}),
    ).rejects.toThrow(HearthError)
  })
})

describe('estimateCostUsd', () => {
  it('prices Sonnet 5.5 and treats unknown models like Opus', () => {
    const u = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }
    expect(estimateCostUsd('claude-sonnet-5-5', u)).toBeCloseTo(12)
    expect(estimateCostUsd('something-else', u)).toBeCloseTo(24)
  })
})
