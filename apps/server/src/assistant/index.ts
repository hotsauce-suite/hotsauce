export { type AssistantEvent, MAX_TURNS, runAgent } from './agent.js'
export {
  AnthropicAssistantModel,
  type AssistantModel,
  FakeAssistantModel,
  UnconfiguredAssistantModel,
} from './model.js'
export { ASSISTANT_MODELS, estimateCostUsd } from './pricing.js'
export { Assistant, type AssistantSettings, assistantName } from './service.js'
export { AssistantStore } from './store.js'

export const DEFAULT_ASSISTANT_MODEL = 'claude-sonnet-5-5'
