import { formatTranscriptLine } from '@hearth/format'
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
}

// Fixed text, so it can be cached and evaluated against a set of meetings (PRD §6.4).
const SYSTEM = `You turn a person's rough meeting notes and the meeting's transcript into clean, structured meeting notes in Markdown.

Rules:
- Keep every line of the raw notes exactly as written, character for character, in their original order. Don't reword, merge, split, fix or punctuate them. They are how the reader tells their own words from yours.
- Add structure and detail around them from the transcript, following the template's sections in order and using its heading lines exactly as given. Each section's instructions say what belongs in it; don't repeat the instructions in the notes.
- Write only what the transcript or the raw notes support. Never invent names, numbers, dates or commitments. If something in the transcript is unclear, say so briefly instead of guessing.
- In the transcript, "Me" is the person who took the notes (named as the note-taker when given) and "Them" is everyone else on the call. Write the note-taker's name, never "Me", when they own an action item or said something worth attributing. Use other attendees' names only where the transcript makes clear who spoke.
- When someone gives a relative due date ("by Friday", "next week") and the meeting's date is given, write the date it means after the words, e.g. "(Friday, Nov 14)".
- Action items are a checklist, "- [ ] Owner: task (due date)", with the owner and due date only when someone stated them.
- Be concise: bullets over paragraphs, no filler.
- Notes from earlier meetings in the same series, when given, are background only: use them to recognise people, follow up open action items and keep continuity. Never present anything from them as said or decided in this meeting unless the transcript or raw notes say so.
- Output only the body of the note in Markdown: no title heading, no frontmatter, no code fence around it, nothing before or after it.`

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

  const transcript = input.transcript
    .filter((s) => s.final)
    .map((s) => formatTranscriptLine({ at: s.at / 1000, speaker: s.speaker, text: s.text }))

  const rawNotes = input.rawNotes.replace(/\r\n?/g, '\n').trim()
  const user = [
    `<meeting>\n${meeting.join('\n')}\n</meeting>`,
    `<template name="${input.template.name}">\n${template.join('\n').trim()}\n</template>`,
    previousBlock(input.previousMeetings),
    `<raw_notes>\n${rawNotes}\n</raw_notes>`,
    rawNotes === '' ? 'The note-taker wrote nothing during this meeting.' : '',
    `<transcript>\n${transcript.length > 0 ? transcript.join('\n') : '(empty)'}\n</transcript>`,
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
