import type { AssistantUsage } from './model.js'

/** List prices in US dollars per million tokens (2026-11). */
interface Price {
  input: number
  output: number
  cacheRead: number
}

const OPUS: Price = { input: 4, output: 20, cacheRead: 0.2 }

const PRICES: Record<string, Price> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-opus-5-5': OPUS,
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
}

/** Models an admin can pick for the assistant, cheapest-sensible first. */
export const ASSISTANT_MODELS = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (fast, recommended)' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (smartest, slower, costs about twice as much)' },
] as const

/**
 * An estimate from list prices: cache writes at 1.25× input (5-minute cache). Unknown models are
 * priced like Opus, so a limit errs on the safe side.
 */
export function estimateCostUsd(model: string, usage: AssistantUsage): number {
  const p = PRICES[model] ?? OPUS
  const perToken = (perMillion: number) => perMillion / 1_000_000
  return (
    usage.input * perToken(p.input) +
    usage.cacheWrite * perToken(p.input * 1.25) +
    usage.cacheRead * perToken(p.cacheRead) +
    usage.output * perToken(p.output)
  )
}
