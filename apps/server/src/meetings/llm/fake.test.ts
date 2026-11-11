import { describe, expect, it } from 'vitest'
import { FakeLLM, scriptedResponse } from './fake.js'

const ask = (content: string) => ({
  model: 'm',
  system: 'sys',
  messages: [{ role: 'user' as const, content }],
})

describe('FakeLLM', () => {
  it('records calls and answers with the chosen response', async () => {
    const llm = new FakeLLM((req) => `echo: ${req.messages[0]?.content}`)
    const result = await llm.complete(ask('hello'))
    expect(result).toEqual({ text: 'echo: hello', usage: { input: 8, output: 11 } })
    expect(llm.calls).toEqual([ask('hello')])
  })
})

describe('scriptedResponse', () => {
  it('keeps raw notes verbatim under the first heading and adds one AI line per section', () => {
    const prompt =
      '<template name="General">\n## Summary\n<!-- what happened -->\n## Action items\n</template>\n\n' +
      '<raw_notes>\nDana wants SSO\r\n\n- pricing by Friday\n</raw_notes>'
    expect(scriptedResponse(ask(prompt))).toBe(
      [
        '## Summary',
        '',
        'Dana wants SSO',
        '- pricing by Friday',
        '- AI summary for Summary',
        '',
        '## Action items',
        '',
        '- AI summary for Action items',
        '',
      ].join('\n'),
    )
  })

  it('cites the first excerpt in a chat answer', () => {
    expect(scriptedResponse(ask('<excerpts>\n[1] a/b.md#L3: x\n</excerpts>\nQ?'))).toBe(
      'Here is what your meetings say [1].',
    )
    expect(scriptedResponse(ask('anything else'))).toBe('I could not find that in your meetings.')
  })
})
