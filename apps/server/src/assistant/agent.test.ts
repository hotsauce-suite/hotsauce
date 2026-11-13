import { describe, expect, it } from 'vitest'
import { type AssistantEvent, MAX_TURNS, runAgent, WAITING_FOR_CONFIRM } from './agent.js'
import type { AssistantModel, ModelTurn } from './model.js'
import type { Toolbox } from './toolbox.js'

function toolbox(calls: string[] = []): Toolbox {
  return {
    tools: [],
    instructions: '',
    kind: (name) =>
      name === 'delete_file' ? 'confirm' : name.startsWith('list') ? 'read' : 'write',
    async call(name) {
      calls.push(name)
      return { text: `${name} ok`, isError: false }
    },
    async close() {},
  }
}

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }

describe('runAgent', () => {
  it(`stops after ${MAX_TURNS} turns and says so, leaving a valid history`, async () => {
    let n = 0
    const model: AssistantModel = {
      async turn(): Promise<ModelTurn> {
        n++
        return {
          content: [{ type: 'tool_use', id: `t${n}`, name: 'list_spaces', input: {} }],
          stopReason: 'tool_use',
          usage,
        }
      },
    }
    const events: AssistantEvent[] = []
    const out = await runAgent({
      model,
      modelId: 'm',
      toolbox: toolbox(),
      system: '',
      messages: [{ role: 'user', content: 'go' }],
      emit: (e) => events.push(e),
    })
    expect(n).toBe(MAX_TURNS)
    expect(out.stoppedEarly).toBe(true)
    expect(out.usage.input).toBe(MAX_TURNS)
    expect(events.at(-1)).toMatchObject({ type: 'text' })
    // Every tool_use is answered by a tool_result before the closing note.
    const roles = out.added.map((m) => m.role)
    expect(roles.slice(0, 4)).toEqual(['assistant', 'user', 'assistant', 'user'])
    expect(roles.at(-1)).toBe('assistant')
  })

  it('never runs a confirm tool, and tells the model it waits', async () => {
    const calls: string[] = []
    let step = 0
    const model: AssistantModel = {
      async turn(): Promise<ModelTurn> {
        step++
        if (step === 1) {
          return {
            content: [
              {
                type: 'tool_use',
                id: 'd',
                name: 'delete_file',
                input: { space: 'team', path: 'a.md' },
              },
            ],
            stopReason: 'tool_use',
            usage,
          }
        }
        return {
          content: [{ type: 'text', text: 'Click Confirm.' }],
          stopReason: 'end_turn',
          usage,
        }
      },
    }
    const events: AssistantEvent[] = []
    const out = await runAgent({
      model,
      modelId: 'm',
      toolbox: toolbox(calls),
      system: '',
      messages: [{ role: 'user', content: 'delete a' }],
      emit: (e) => events.push(e),
    })
    expect(calls).toEqual([])
    expect(events.map((e) => e.type)).toEqual(['tool', 'confirm', 'tool_result'])
    expect(JSON.stringify(out.added[1])).toContain(WAITING_FOR_CONFIRM.slice(0, 20))
  })

  it('runs writes one at a time and reads alongside them', async () => {
    const order: string[] = []
    const box = toolbox()
    box.call = async (name) => {
      order.push(`start ${name}`)
      await new Promise((r) => setTimeout(r, name === 'write_a' ? 20 : 1))
      order.push(`end ${name}`)
      return { text: 'ok', isError: false }
    }
    let step = 0
    const model: AssistantModel = {
      async turn(): Promise<ModelTurn> {
        step++
        if (step > 1)
          return { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage }
        return {
          content: ['write_a', 'write_b', 'list_x'].map((name) => ({
            type: 'tool_use' as const,
            id: name,
            name,
            input: {},
          })),
          stopReason: 'tool_use',
          usage,
        }
      },
    }
    await runAgent({ model, modelId: 'm', toolbox: box, system: '', messages: [], emit: () => {} })
    expect(order.indexOf('end write_a')).toBeLessThan(order.indexOf('start write_b'))
    expect(order.indexOf('start list_x')).toBeLessThan(order.indexOf('end write_a'))
  })
})
