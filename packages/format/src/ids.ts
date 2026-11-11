import { ulid } from 'ulid'

// Crockford base32, uppercase. The first character is 0-7 because the timestamp is 48 bits.
const ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/

/** A new ULID: sortable by creation time, uppercase Crockford base32. */
export function newId(): string {
  return ulid()
}

export function isId(s: string): boolean {
  return ID.test(s)
}
