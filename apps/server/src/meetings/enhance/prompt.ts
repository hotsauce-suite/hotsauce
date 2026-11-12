import { dropEchoes, formatTranscriptLine, UNNAMED_SPEAKER } from '@hearth/format'
import type { TemplateDoc } from '../templates.js'
import type { TranscriptSegment } from '../transcriber/types.js'

export interface EnhanceInput {
  title: string
  template: TemplateDoc
  rawNotes: string
  transcript: TranscriptSegment[]
  attendees: string[]
  /** Who took the notes: "Me" in the transcript. */
  noteTaker?: string
  /** When the meeting started, as the note's frontmatter has it (ISO with offset). */
  date?: string
  calendar?: { title: string; description?: string }
  /** Earlier notes of the same recurring meeting, newest first: context only. */
  previousMeetings?: Array<{ title: string; date: string; notes: string }>
  /** The note still has its placeholder title: ask for one (a voice note, named by what was said). */
  nameIt?: boolean
}

/** What a model asked to name the note writes on its first line, before the body. */
export const TITLE_LINE = /^Title:[ \t]*(.*)$/

// Fixed text, so it can be cached and evaluated against a set of meetings (PRD §6.4).
const SYSTEM = `You turn a person's rough meeting notes and the meeting's transcript into clean, structured meeting notes in Markdown.

Rules:
- Keep every line of the raw notes exactly as written, character for character, in their original order. Don't reword, merge, split, fix or punctuate them. They are how the reader tells their own words from yours.
- Add structure and detail around them from the transcript, following the template's sections in order and using its heading lines exactly as given. Each section's instructions say what belongs in it; don't repeat the instructions in the notes.
- Write only what the transcript or the raw notes support. Never invent names, numbers, dates or commitments. If something in the transcript is unclear, say so briefly instead of guessing.
- In the transcript, "Me" is the person who took the notes (named as the note-taker when given) and "Them" is everyone else on the call. Write the note-taker's name, never "Me", when they own an action item or said something worth attributing. Use other attendees' names only where the transcript makes clear who spoke.
- "Speaker 1", "Speaker 2" and so on are different people on the call whose names aren't known yet. Where you attribute something to one of them, write the label exactly as it is ("Speaker 2"), never a name you guessed: the note-taker names them afterwards and the label is replaced everywhere.
- When someone gives a relative due date ("by Friday", "next week") and the meeting's date is given, write the date it means after the words, e.g. "(Friday, Nov 14)".
- Action items are a checklist, "- [ ] Owner: task (due date)", with the owner and due date only when someone stated them.
- Be concise: bullets over paragraphs, no filler.
- Notes from earlier meetings in the same series, when given, are background only: use them to recognise people, follow up open action items and keep continuity. Never present anything from them as said or decided in this meeting unless the transcript or raw notes say so.
- Output only the body of the note in Markdown: no title heading, no frontmatter, no code fence around it, nothing before or after it.`

/** What a model asked who's who writes on its own line before the body (after any Title line). */
export const SPEAKERS_LINE = /^Speakers:[ \t]*(.*)$/

const WHO_IS_WHO = `The transcript has unnamed speakers (Speaker 1, Speaker 2…). Before the body (after the Title line, if you write one), write one line "Speakers: " followed by your best guess for each, like "Speaker 1 = Priya Shah; Speaker 2 = ?". Only use a name from the attendees list, and only when the transcript points to it (someone is addressed by name, introduces themselves, or is the only attendee who could have said it); otherwise write "?". Then a blank line, then the body.`

const NAME_IT = `This note has no title yet. Before the body, write one line "Title: " followed by a short title for it (at most eight words, no quotes, no date), then a blank line, then the body.`

/** The system prompt and the one user message for an enhancement (ARCHITECTURE §7.1). */
export function buildEnhancePrompt(input: EnhanceInput): { system: string; user: string } {
  const meeting = [`Title: ${input.title}`]
  if (input.date) meeting.push(`Date: ${input.date}`)
  if (input.noteTaker) meeting.push(`Note-taker: ${input.noteTaker}`)
  if (input.attendees.length > 0) {
    meeting.push('Attendees:', ...input.attendees.map((a) => `- ${a}`))
  }
  if (input.calendar) {
    meeting.push(`Calendar event: ${input.calendar.title}`)
    if (input.calendar.description?.trim()) {
      meeting.push('Calendar description:', input.calendar.description.trim())
    }
  }

  const template: string[] = []
  if (input.template.preamble) template.push(input.template.preamble, '')
  for (const section of input.template.sections) {
    template.push(section.heading)
    if (section.instructions) template.push(section.instructions)
    template.push('')
  }

  const transcript = dropEchoes(input.transcript.filter((s) => s.final)).map((s) =>
    formatTranscriptLine({ at: s.at / 1000, speaker: s.speaker, text: s.text }),
  )

  const rawNotes = input.rawNotes.replace(/\r\n?/g, '\n').trim()
  const user = [
    `<meeting>\n${meeting.join('\n')}\n</meeting>`,
    `<template name="${input.template.name}">\n${template.join('\n').trim()}\n</template>`,
    previousBlock(input.previousMeetings),
    `<raw_notes>\n${rawNotes}\n</raw_notes>`,
    rawNotes === '' ? 'The note-taker wrote nothing during this meeting.' : '',
    `<transcript>\n${transcript.length > 0 ? transcript.join('\n') : '(empty)'}\n</transcript>`,
    input.nameIt ? NAME_IT : '',
    unnamedSpeakers(input.transcript).length > 0 && input.attendees.length > 0 ? WHO_IS_WHO : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  return { system: SYSTEM, user }
}

function previousBlock(previous: EnhanceInput['previousMeetings']): string {
  if (!previous?.length) return ''
  // Someone else's text: it can't close the block it sits in.
  const fence = (text: string) => text.replace(/<(\/?)(previous_meetings?)/gi, '&lt;$1$2')
  const attr = (text: string) => fence(text).replace(/"/g, "'")
  const notes = previous.map(
    (p) =>
      `<previous_meeting title="${attr(p.title)}" date="${attr(p.date)}">\n${fence(p.notes)}\n</previous_meeting>`,
  )
  return `<previous_meetings>\n${notes.join('\n')}\n</previous_meetings>`
}

/** The diarized labels ("Speaker 1"…) still in the transcript, in first-heard order. */
export function unnamedSpeakers(transcript: TranscriptSegment[]): string[] {
  const out: string[] = []
  for (const s of transcript) {
    if (UNNAMED_SPEAKER.test(s.speaker) && !out.includes(s.speaker)) out.push(s.speaker)
  }
  return out
}
