import type { LLM, LLMRequest, LLMUsage } from './types.js'

export type Respond = (req: LLMRequest) => string | Promise<string>

/**
 * Deterministic stand-in for Claude (LLM_PROVIDER=fake, the default in development and test).
 * Records every request; tests choose the text with `respond`. Usage counts characters, not
 * tokens, so it is stable.
 */
export class FakeLLM implements LLM {
  readonly calls: LLMRequest[] = []
  readonly #respond: Respond

  constructor(respond: Respond = scriptedResponse) {
    this.#respond = respond
  }

  async complete(req: LLMRequest): Promise<{ text: string; usage: LLMUsage }> {
    this.calls.push(req)
    const text = await this.#respond(req)
    const input = req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0)
    return { text, usage: { input, output: text.length } }
  }
}

/**
 * What the fake says when a test doesn't choose: enough for the app to work end to end in
 * development and e2e. An enhance request (it carries `<raw_notes>`) gets the template's
 * headings with the raw notes kept verbatim under the first and one AI bullet under each; a
 * chat request (it carries `<excerpts>`) gets an answer citing the first excerpt; a dictation
 * cleanup (it carries `<transcript>`) gets the transcript without "um" and "uh".
 */
export function scriptedResponse(req: LLMRequest): string {
  const prompt = req.messages.at(-1)?.content ?? ''
  const rawNotes = tagged(prompt, 'raw_notes')
  if (rawNotes !== null) {
    const template = tagged(prompt, 'template') ?? ''
    const headings = template.split('\n').filter((line) => /^#{2,6} /.test(line))
    const notes = rawNotes.split(/\r?\n/).filter((line) => line.trim() !== '')
    const sections = (headings.length > 0 ? headings : ['## Notes']).map((heading, i) =>
      [
        heading,
        '',
        ...(i === 0 ? notes : []),
        `- AI summary for ${heading.replace(/^#+ /, '')}`,
      ].join('\n'),
    )
    return `${sections.join('\n\n')}\n`
  }
  // A Hearth Clips title and summary: named after the clip's first line.
  const clip = tagged(prompt, 'clip_transcript')
  if (clip !== null) {
    const first = clip.split('\n')[0]?.replace(/^\[[\d:]+\]\s*/, '') ?? ''
    return `<title>About ${first}</title><summary>A fake summary of a clip that starts with “${first}”.</summary>`
  }
  const transcript = tagged(prompt, 'transcript')
  if (transcript !== null) {
    const cleaned = transcript
      .replace(/\b(um|uh),?\s*/gi, '')
      .replace(/\s+,/g, ',')
      .trim()
    return `<cleaned>${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}</cleaned>`
  }
  const excerpts = tagged(prompt, 'excerpts')
  if (excerpts?.includes('[1]')) return 'Here is what your meetings say [1].'
  return 'I could not find that in your meetings.'
}

function tagged(text: string, tag: string): string | null {
  const match = new RegExp(`<${tag}(?: [^>]*)?>\\n?([\\s\\S]*?)\\n?</${tag}>`).exec(text)
  return match ? (match[1] ?? '') : null
}
