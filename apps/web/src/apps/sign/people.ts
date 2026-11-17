// The people on a draft envelope (docs/PLAN-sign.md R10): who signs, who only gets a copy, and in
// what order. The sender edits them as a list; the order is the list's order.

import type { DraftPerson, SignField } from '../../api/sign'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** A person id not used yet (`s1`, `s2`, …), as the format allows. */
export function nextPersonId(people: readonly Pick<DraftPerson, 'id'>[]): string {
  const used = new Set(people.map((p) => p.id))
  let n = 1
  while (used.has(`s${n}`)) n++
  return `s${n}`
}

/** The list as it is saved: `order` follows the list, names and emails trimmed. */
export function ordered(people: readonly DraftPerson[]): DraftPerson[] {
  return people.map((p, i) => ({
    ...p,
    name: p.name.replace(/\s+/g, ' ').trim(),
    email: p.email.trim().toLowerCase(),
    order: i + 1,
  }))
}

/** What stops the list being saved, in plain words; null when it's fine. */
export function peopleProblem(people: readonly DraftPerson[]): string | null {
  if (people.length === 0) return 'Add someone to sign'
  const seen = new Set<string>()
  for (const p of ordered(people)) {
    if (!p.name) return 'Give each person a name'
    if (!EMAIL.test(p.email)) return `“${p.email || p.name}” isn’t an email address`
    if (seen.has(p.email)) return `${p.email} is on the list twice`
    seen.add(p.email)
  }
  if (!people.some((p) => p.role !== 'copy')) return 'Add someone to sign'
  return null
}

/** Fields that still belong to someone who signs; a removed person or a copy has none. */
export function keptFields(fields: readonly SignField[], people: readonly DraftPerson[]) {
  const signing = new Set(people.filter((p) => p.role !== 'copy').map((p) => p.id))
  return fields.filter((f) => signing.has(f.signer))
}

/** Moves a person one place up the list. */
export function moveUp<T>(list: readonly T[], index: number): T[] {
  if (index <= 0 || index >= list.length) return [...list]
  const out = [...list]
  const [item] = out.splice(index, 1)
  out.splice(index - 1, 0, item as T)
  return out
}

/** A short name for a field's label: the first word of a person's name. */
export const shortName = (name: string) => name.trim().split(/\s+/)[0] ?? name
