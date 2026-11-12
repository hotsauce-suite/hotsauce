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
 * cleanup (it carries `<transcript>`) gets the transcript without "um" and "uh"; a Tasks ramble
 * (it carries `<ramble>`) gets one task line per sentence.
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
    // A voice note still to be named gets a title from the start of what was said.
    const named = prompt.includes('This note has no title yet')
      ? `Title: About ${firstWords(tagged(prompt, 'transcript') ?? '')}\n\n`
      : ''
    return `${named}${sections.join('\n\n')}\n`
  }
  // After-call transcript cleanup's spelling pass: nothing to fix unless a test says so.
  if (tagged(prompt, 'cleanup_transcript') !== null) return '[]'
  // A Hearth Clips title and summary: named after the clip's first line.
  const clip = tagged(prompt, 'clip_transcript')
  if (clip !== null) {
    const first = clip.split('\n')[0]?.replace(/^\[[\d:]+\]\s*/, '') ?? ''
    return `<title>About ${first}</title><summary>A fake summary of a clip that starts with “${first}”.</summary>`
  }
  // A Briefcast script (it carries `<calendar_today>`): names what it was given, with a little
  // markdown and a link that the cleaner must remove before it is read aloud.
  const today = tagged(prompt, 'calendar_today')
  if (today !== null) {
    const titles = (tag: string) =>
      [...(tagged(prompt, tag) ?? '').matchAll(/<(?:event|meeting|doc) [^>]*title="([^"]*)"/g)]
        .map((m) => m[1])
        .join(', ') || 'nothing'
    const tasks = (tagged(prompt, 'tasks') ?? '').split('\n')[0]?.replace(/^- /, '') ?? ''
    return [
      '## Your morning',
      '',
      `**Good morning.** Today: ${titles('calendar_today')}.`,
      '',
      `- Recent meetings: ${titles('recent_meetings')}.`,
      '',
      `Changed docs: ${titles('changed_docs')}. Due: ${tasks}. See [the doc](https://example.test/x).`,
      '',
      'Have a good day.',
    ].join('\n')
  }
  // An agent brief (it carries `<previous_brief>`): each section asked for, with one line naming
  // the newest meeting and the member's notes, so tests can see what the model was given.
  const previous = tagged(prompt, 'previous_brief')
  if (previous !== null) {
    const asked = prompt.slice(
      prompt.indexOf('Write these sections:'),
      prompt.indexOf('<their_notes>'),
    )
    const headings = asked.split('\n').filter((line) => /^## /.test(line))
    const newest = /<meeting [^>]*title="([^"]*)"/.exec(prompt)?.[1] ?? 'no meetings'
    const notes = tagged(prompt, 'their_notes') ?? ''
    return headings
      .map((h, i) =>
        [
          h,
          '',
          i === 0
            ? `- Newest meeting: ${newest}. Notes: ${notes.split('\n')[0]}`
            : `- Fake ${h.slice(3)}`,
        ].join('\n'),
      )
      .join('\n\n')
  }
  // Send feedback's clarify step: a short report with no answers yet gets one question; anything
  // else is ready, titled with its first line.
  const feedback = tagged(prompt, 'feedback')
  if (feedback !== null) {
    const words = feedback.trim().split(/\s+/).filter(Boolean).length
    if (words < 6 && !prompt.includes('<answers>') && !prompt.includes('Do not ask more')) {
      return '<result>{"ready": false, "questions": ["What were you doing when it happened?"]}</result>'
    }
    const title = (feedback.trim().split('\n')[0] ?? '').slice(0, 80).replace(/"/g, "'")
    return `<result>${JSON.stringify({ ready: true, title, summary: `Summary: ${feedback.trim()}` })}</result>`
  }
  // A Hearth Tasks ramble: one quick-add line per sentence of what was said.
  const ramble = tagged(prompt, 'ramble')
  if (ramble !== null) return `<tasks>\n${rambleLines(ramble).join('\n')}\n</tasks>`
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

/**
 * The sentences of a ramble: split on a `.` that ends a sentence (followed by a space or the end,
 * so "1.5" stays whole), `;`, " and then " and " also ".
 */
export function rambleLines(text: string): string[] {
  return text
    .split(/\.(?=\s|$)|;| and then | also /i)
    .map((s) => s.trim())
    .filter(Boolean)
}

function tagged(text: string, tag: string): string | null {
  const match = new RegExp(`<${tag}(?: [^>]*)?>\\n?([\\s\\S]*?)\\n?</${tag}>`).exec(text)
  return match ? (match[1] ?? '') : null
}

/** The first few words said in a transcript block, without the timestamp and speaker. */
function firstWords(transcript: string): string {
  const line = transcript.split('\n').find((l) => /\S/.test(l) && l !== '(empty)') ?? ''
  const text = line.replace(/^\[[\d:]+\]\s*(\*\*[^*]+:\*\*\s*)?/, '')
  return text.split(/\s+/).slice(0, 5).join(' ') || 'nothing much'
}
